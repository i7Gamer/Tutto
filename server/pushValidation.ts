import { MAX_HISTORY_LOG_SIZE, MAX_CHAIN_CARDS, type CardType, type InitialCards, type DiceSnapshot, type HistoryEntry, type TurnSummary, type TurnCardPlayed } from '../src/types';
import {
  isSnapshotDie, isRolledDie, isKniffelProgressEntry, isRollingDiceIdList,
  isChainCard, isChainCounter, isChainScoreList, isDeductedAmountList, isTurnCardList, isTurnEnd,
  TOTAL_DICE,
} from '../src/utils/turnShapes';
import {
  isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry,
  isValidEnforcedDiceMode, isValidRuleset,
  MAX_CARD_COUNT, VALID_CARD_TYPES,
  MAX_TURN_DURATION, MAX_PLAYER_NAME_LENGTH,
} from '../src/utils/configValidation';
import { PLAYER_STAT_FIELDS } from '../src/utils/playerStats';
import { getLeaders } from '../src/utils/coreGameEngine';
import { roomPhase } from '../src/utils/roomPhase';
import type { SyncedGameStateKey, AssertNever, ConfigKeys } from '../src/types';
import type { RoomState, ServerPlayer } from './roomTypes';

// A fully-loaded deck has at most MAX_CARD_COUNT of each of the 11 card types.
const MAX_DECK_SIZE = MAX_CARD_COUNT * 11;
// Exported for turnTimers.ts: the timeout path appends its own round-end
// datapoints and must respect the same bound the pushed arrays get.
// Generous safety cap for per-round arrays (chartLabels/chartValues entries) — far
// beyond any real game, just enough to stop a malicious pushState from growing
// these arrays without bound.
export const MAX_ROUNDS = 100000;
// Exported so the tests can assert the bound itself rather than restating it.
export const MAX_SCORE_MAGNITUDE = 1_000_000;
const MAX_GAME_SECONDS = 10_000_000;
// A history-entry id is a client-generated string (see HistoryEntry in
// src/types.ts) — this is a sanity bound, not a format, same role as
// MAX_ROOM_ID_LENGTH plays for room ids.
const MAX_HISTORY_ID_LENGTH = 100;

// The bound every numeric in a client-pushed payload must clear: finite AND
// within the sanity cap. Named once so a new field cannot accidentally settle
// for finiteness alone (which is how turnScore came to be uncapped).
const isBoundedNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCORE_MAGNITUDE;

// chartValues and chartNames carry one entry per seat, so they are tied to the
// roster length -- EXCEPT when empty, which is the cleared chart. endGame
// pushes the whole trio empty at once and leaves the roster alone, so a strict
// tie refused two thirds of that clear and the room kept the finished game's
// series under an empty set of round labels. Wiping a chart is also strictly
// less than a push may already do to it (replace every entry), so allowing it
// opens nothing.
const isPerPlayerOrCleared = (v: unknown[], players: readonly unknown[]): boolean =>
  v.length === 0 || v.length === players.length;

// The chain's Plus/Minus running totals: shape from turnShapes, magnitude the
// network's own rule — the engine adds each one to a player's score, so an
// unbounded entry off the wire is an unbounded score.
const isPlusMinusScoreList = (v: unknown): v is number[] =>
  isChainScoreList(v) && v.every(n => n <= MAX_SCORE_MAGNITUDE);

// The shared shape (array, index parity with deductedPlayers, non-negative
// finite entries — see turnShapes) plus this boundary's own rule: bounded like
// every other pushed score, because the log renders these numbers to every
// client in the room.
const isBoundedDeductedAmountList = (amounts: unknown, names: unknown): boolean =>
  isDeductedAmountList(amounts, names) && amounts.every(n => n <= MAX_SCORE_MAGNITUDE);

export const validateInitialCards = (cards: unknown): cards is InitialCards => {
  if (typeof cards !== 'object' || cards === null) return false;
  const entries = Object.entries(cards as Record<string, unknown>);
  if (entries.length === 0) return false;
  const shapeValid = entries.every(([key, val]) => isValidCardEntry(key, val));
  if (!shapeValid) return false;
  // An all-zero deck leaves currentCard permanently null and the game unplayable.
  return entries.some(([, val]) => (val as number) > 0);
};

// Applies only the config fields that pass validation, silently ignoring the
// rest. Shared by every path that lets a client write room configuration
// (updateConfig and joinRoom's initialConfig) so the accepted ranges can never
// drift apart between them.
export const applyValidatedConfig = (state: RoomState, config: Record<string, unknown>): void => {
  const { winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout, enforcedDiceMode, ruleset } = config;
  if (isValidWinningScore(winningScore)) state.winningScore = winningScore;
  if (validateInitialCards(initialCards)) state.initialCards = initialCards;
  if (typeof randomOrder === 'boolean') state.randomOrder = randomOrder;
  if (isValidTurnDuration(turnDuration)) state.turnDuration = turnDuration;
  if (isValidReconnectTimeout(reconnectTimeout)) state.reconnectTimeout = reconnectTimeout;
  if (isValidEnforcedDiceMode(enforcedDiceMode)) state.enforcedDiceMode = enforcedDiceMode;
  if (isValidRuleset(ruleset)) state.ruleset = ruleset;
};

// Minimal shape check for a previousLeaders snapshot entry — just enough for
// calculateUndo (client-side) to read name/score back out safely. Bounded like
// every other pushed name and score: undo restores these scores onto real
// players, and the entries ride every later broadcast until the next turn
// overwrites them, so one push could otherwise plant a megabyte-long name or a
// 1e308 score and have the server re-send it to the whole room.
export const isPlausiblePlayerSnapshot = (v: unknown): v is { name: string; score: number } => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!(typeof p.name === 'string' && p.name.length > 0 && p.name.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  return typeof p.score === 'number' && Number.isFinite(p.score) && Math.abs(p.score) <= MAX_SCORE_MAGNITUDE;
};

// Every array element is shape-checked, not just the array's length: a
// spectator's client (GameControls.tsx) renders keptDice/currentRoll entries'
// `.val` directly into JSX, so a malformed element (e.g. an object where a
// number is expected) reaching every viewer via broadcast crashes their
// render and trips the ErrorBoundary's cache-clear-and-reload for all of
// them, repeatedly, until the sender's next push is well-formed again.
// rollingDiceIds/busted are optional but, when present, are shape-checked too:
// the same render membership-tests rollingDiceIds per die, so a non-array has
// no `.includes` and throws there just as surely (see isRollingDiceIdList),
// and busted only ever needs to be a boolean.
export const isValidDiceSnapshot = (v: unknown): v is DiceSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  // Bounded, not merely finite, like every other numeric in this file: the
  // liveTurnState handler accepts `isHost || isActivePlayer`, so a patched
  // host can plant a snapshot for ANOTHER player's turn and then force expiry
  // (shortening turnDuration mid-game). turnTimers reads turnScore straight
  // into that player's highestForfeitedTurnScore, which their own unmodified
  // client then submits for their device — where the DB merges it with MAX,
  // permanently.
  if (!isBoundedNumber(s.turnScore)) return false;
  if (!isBoundedNumber(s.tuttosThisTurn)) return false;
  if (!(Array.isArray(s.keptDice) && s.keptDice.length <= TOTAL_DICE && s.keptDice.every(isSnapshotDie))) return false;
  if (!(Array.isArray(s.currentRoll) && s.currentRoll.length <= TOTAL_DICE && s.currentRoll.every(isRolledDie))) return false;
  if (!(Array.isArray(s.kniffelProgress) && s.kniffelProgress.length <= TOTAL_DICE && s.kniffelProgress.every(isKniffelProgressEntry))) return false;
  if (s.busted !== undefined && typeof s.busted !== 'boolean') return false;
  if (s.stopped !== undefined && typeof s.stopped !== 'boolean') return false;
  if (s.rollingDiceIds !== undefined && !isRollingDiceIdList(s.rollingDiceIds)) return false;
  // Classic-chain fields — optional, but shape-checked when present: a mid-
  // chain reconnect rebuilds the active player's own resume cache from this
  // relayed snapshot, so a stripped or corrupted chain would lose their turn.
  if (s.cardsThisTurn !== undefined) {
    if (!Array.isArray(s.cardsThisTurn) || s.cardsThisTurn.length > MAX_CHAIN_CARDS) return false;
    if (!s.cardsThisTurn.every(isChainCard)) return false;
  }
  if (s.plusMinusScores !== undefined && !isPlusMinusScoreList(s.plusMinusScores)) return false;
  if (s.chainTuttoCount !== undefined && !isChainCounter(s.chainTuttoCount)) return false;
  if (s.lastCardCompleted !== undefined && typeof s.lastCardCompleted !== 'boolean') return false;
  return true;
};

// Rebuilds a validated snapshot from only its known fields, dropping anything
// else the sender attached. isValidDiceSnapshot only checks shape — without
// this, applyPushedState would still store (and rebroadcast) the client's
// object as-is, extra properties included.
export const sanitizeDiceSnapshot = (v: DiceSnapshot): DiceSnapshot => {
  const clean: DiceSnapshot = {
    turnScore: v.turnScore,
    keptDice: v.keptDice.map(d => ({ id: d.id, val: d.val })),
    currentRoll: v.currentRoll.map(d => ({ id: d.id, val: d.val, selected: d.selected })),
    kniffelProgress: [...v.kniffelProgress],
    tuttosThisTurn: v.tuttosThisTurn,
  };
  if (v.busted) clean.busted = true;
  if (v.stopped) clean.stopped = true;
  if (v.rollingDiceIds) clean.rollingDiceIds = [...v.rollingDiceIds];
  if (v.cardsThisTurn) clean.cardsThisTurn = [...v.cardsThisTurn];
  if (v.plusMinusScores !== undefined) clean.plusMinusScores = [...v.plusMinusScores];
  if (v.chainTuttoCount !== undefined) clean.chainTuttoCount = v.chainTuttoCount;
  if (v.lastCardCompleted) clean.lastCardCompleted = true;
  return clean;
};

// The previous turn's classic summary rides pushState so undo works for every
// client after a broadcast/reconnect. Bounded like everything else a push may
// store: card list ≤ MAX_CHAIN_CARDS, counters bounded, names length-capped.
export const isValidTurnSummary = (v: unknown): v is TurnSummary => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isTurnCardList(s.cards)) return false;
  if (!isChainCounter(s.tuttoCount)) return false;
  if (!isPlusMinusScoreList(s.plusMinusScores)) return false;
  if (!isTurnEnd(s.ended)) return false;
  if (s.forfeitedScore !== undefined &&
      !(typeof s.forfeitedScore === 'number' && Number.isFinite(s.forfeitedScore) && s.forfeitedScore >= 0 && s.forfeitedScore <= MAX_SCORE_MAGNITUDE)) return false;
  const isRecordOrNull = (v2: unknown): boolean =>
    v2 === null || (typeof v2 === 'number' && Number.isFinite(v2) && v2 >= 0 && v2 <= MAX_SCORE_MAGNITUDE);
  if (s.prevMostCardsInTurn !== undefined && !isRecordOrNull(s.prevMostCardsInTurn)) return false;
  if (s.prevHighestForfeitedTurnScore !== undefined && !isRecordOrNull(s.prevHighestForfeitedTurnScore)) return false;
  if (s.deductedPlayers !== undefined) {
    if (!Array.isArray(s.deductedPlayers) || s.deductedPlayers.length > MAX_CHAIN_CARDS) return false;
    if (!s.deductedPlayers.every(n => typeof n === 'string' && n.length > 0 && n.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  }
  // Optional: a modernized turn records none, and a client predating the field
  // sends none — both must stay valid.
  if (s.deductedAmounts !== undefined && !isBoundedDeductedAmountList(s.deductedAmounts, s.deductedPlayers)) return false;
  return true;
};

export const sanitizeTurnSummary = (v: TurnSummary): TurnSummary => {
  const clean: TurnSummary = {
    cards: v.cards.map((c: TurnCardPlayed) => ({ card: c.card, completed: c.completed })),
    tuttoCount: v.tuttoCount,
    plusMinusScores: [...v.plusMinusScores],
    ended: v.ended,
  };
  if (v.forfeitedScore !== undefined) clean.forfeitedScore = v.forfeitedScore;
  if (v.prevMostCardsInTurn !== undefined) clean.prevMostCardsInTurn = v.prevMostCardsInTurn;
  if (v.prevHighestForfeitedTurnScore !== undefined) clean.prevHighestForfeitedTurnScore = v.prevHighestForfeitedTurnScore;
  if (v.deductedPlayers) clean.deductedPlayers = [...v.deductedPlayers];
  if (v.deductedAmounts) clean.deductedAmounts = [...v.deductedAmounts];
  return clean;
};

const isValidHistoryEntry = (v: unknown): v is HistoryEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const entry = v as Record<string, unknown>;
  const validTypes = ['success', 'bust', 'skip', 'fail'];

  if (!(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= MAX_HISTORY_ID_LENGTH)) return false;
  if (!(typeof entry.round === 'number' && Number.isInteger(entry.round) && entry.round >= 1 && entry.round <= MAX_ROUNDS)) return false;
  if (!(typeof entry.playerName === 'string' && entry.playerName.length > 0 && entry.playerName.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  if (entry.playerColor !== undefined && !(typeof entry.playerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.playerColor))) return false;
  if (!(typeof entry.card === 'string' && (VALID_CARD_TYPES as readonly string[]).includes(entry.card))) return false;
  if (!(typeof entry.type === 'string' && validTypes.includes(entry.type))) return false;
  if (!(typeof entry.score === 'number' && Number.isFinite(entry.score) && Math.abs(entry.score) <= MAX_SCORE_MAGNITUDE)) return false;
  if (entry.deductedPlayers !== undefined) {
    if (!Array.isArray(entry.deductedPlayers)) return false;
    if (entry.deductedPlayers.length > MAX_CHAIN_CARDS) return false;
    if (!entry.deductedPlayers.every(name => typeof name === 'string' && name.length > 0 && name.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  }
  // Same index-alignment rule as the turn summary's — this is the entry the
  // activity log actually renders, so a misaligned pair would be printed.
  if (entry.deductedAmounts !== undefined && !isBoundedDeductedAmountList(entry.deductedAmounts, entry.deductedPlayers)) return false;
  if (entry.cards !== undefined) {
    if (!Array.isArray(entry.cards) || entry.cards.length > MAX_CHAIN_CARDS) return false;
    if (!entry.cards.every(c => typeof c === 'string' && (VALID_CARD_TYPES as readonly string[]).includes(c))) return false;
  }
  return true;
};

const sanitizeHistoryEntry = (v: HistoryEntry): HistoryEntry => {
  const clean: HistoryEntry = {
    id: v.id,
    round: v.round,
    playerName: v.playerName,
    card: v.card,
    type: v.type,
    score: v.score,
  };
  if (v.playerColor) clean.playerColor = v.playerColor;
  if (v.cards) clean.cards = [...v.cards];
  if (v.deductedPlayers) clean.deductedPlayers = [...v.deductedPlayers];
  // Rebuilt from a fixed field list, so an amount not copied here is stripped
  // from every relayed push: the sender would see the clamped 400 their own
  // engine recorded while everyone else read the flat 1000.
  if (v.deductedAmounts) clean.deductedAmounts = [...v.deductedAmounts];
  return clean;
};

// Frozen so a later `.add()`/`.delete()` fails loudly (TypeError) instead of
// silently expanding/shrinking what a push is allowed to touch. The lists are
// separate `as const` arrays so the compiler can hold them against the
// canonical synced-field set (the satisfies here, and PushFieldLock below);
// the Sets stay string-keyed for the arbitrary payload keys they are probed with.
const HOST_ONLY_FIELD_LIST = [
  'status', 'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout', 'enforcedDiceMode', 'ruleset',
] as const satisfies readonly SyncedGameStateKey[];
const HOST_ONLY_FIELDS: ReadonlySet<SyncedGameStateKey> =
  Object.freeze(new Set<SyncedGameStateKey>(HOST_ONLY_FIELD_LIST));

const ACTIVE_PLAYER_FIELD_LIST = [
  'currentCard', 'cards', 'currentPlayerIndex', 'round',
  'previousCard', 'previousScore', 'previousLeaders',
  'previousWasBust', 'previousWasSuccess',
  'previousHighestTurnScore', 'previousHighestFeuerwerkTurnScore',
  'previousHighestX2TurnScore', 'previousPlayerName', 'previousTurnSummary',
  'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
  'players',
  // AFTER 'players', deliberately: the winning push carries the score and the
  // finish together, and the game-over check below has to see the merged
  // roster. Ordered like 'status', which is first for the mirror-image reason.
  'finished',
  'liveTurnState', 'historyLog',
] as const satisfies readonly SyncedGameStateKey[];
const ACTIVE_PLAYER_FIELDS: ReadonlySet<SyncedGameStateKey> =
  Object.freeze(new Set<SyncedGameStateKey>(ACTIVE_PLAYER_FIELD_LIST));

// The two lists must partition the synced game state: together they cover
// every synced field, and no field sits in both. A field missing from both
// was this codebase's most common defect — applyPushedState loops the
// allowlist, not the payload, so the field was silently stripped from every
// push with nothing failing. Now it refuses to build, naming the key.
//
// Membership is only half of it, and this lock used to be described as if it
// were the whole: a key can sit in an allowlist and still have no branch in
// the dispatch chain below, which drops it just as silently. That half is
// covered by the chain's terminal `else` (assertHandled), not here.
// Exported only so noUnusedLocals sees a use; nothing imports it.
export type PushFieldLock = [
  AssertNever<Exclude<SyncedGameStateKey, (typeof HOST_ONLY_FIELD_LIST)[number] | (typeof ACTIVE_PLAYER_FIELD_LIST)[number]>>,
  AssertNever<Extract<(typeof HOST_ONLY_FIELD_LIST)[number], (typeof ACTIVE_PLAYER_FIELD_LIST)[number]>>,
];

const ALL_FIELDS: ReadonlySet<SyncedGameStateKey> =
  Object.freeze(new Set<SyncedGameStateKey>([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]));

// Sanity-guard bounds for the two timers arriving via pushState — not a UX
// rule (pushState mirrors state the client already ran through updateConfig,
// and tests legitimately push short 1-2s turns, below isValidTurnDuration's
// enabled-minimum), just enough to reject values that would corrupt
// server-side logic: a negative/non-finite turnDuration makes
// startServerTurnTimer re-arm with remaining<=0 and advance turns in a
// synchronous loop until the stack overflows. winningScore is validated with
// the real isValidWinningScore (see the dedicated branch below) instead of
// living in this table — unlike the timers, it has no "loose sanity range"
// use case, so it should enforce exactly the same rule as updateConfig; a
// looser check here would make pushState a side door for a winning score
// updateConfig had just rejected.
// The config a running game must not have changed underneath it — the same set
// updateConfig refuses mid-game (socketConfigHandlers.ts), enforced here too
// because pushState reaches every one of these fields. Only `ruleset` used to
// carry the check, so the guard was one config path wide.
const LOBBY_ONLY_CONFIG_FIELD_LIST = [
  'winningScore', 'initialCards', 'randomOrder',
  'enforcedDiceMode', 'reconnectTimeout', 'ruleset',
] as const satisfies readonly SyncedGameStateKey[];
const LOBBY_ONLY_CONFIG_FIELDS: ReadonlySet<string> =
  Object.freeze(new Set<string>(LOBBY_ONLY_CONFIG_FIELD_LIST));

// The one config field a running game MAY still change, on this path and in
// updateConfig alike: the host shortens the turn to 0 mid-turn to cancel a
// pending expiry. No UI exposes it; the server supports it intentionally (see
// turnTimer.test.ts's "turnDuration=0 mid-turn cancels a pending expiry").
const MID_GAME_CONFIG_FIELD = 'turnDuration';

// Locks the split above to the config surface itself: a new config key must be
// named on one side or the other, or this fails to build. Without it the
// default is silence — an unlisted key is simply writable at any time, which
// is the state every field except `ruleset` was in.
// Exported only so noUnusedLocals sees a use; nothing imports it.
export type LobbyOnlyConfigLock = [
  AssertNever<Exclude<ConfigKeys, (typeof LOBBY_ONLY_CONFIG_FIELD_LIST)[number] | typeof MID_GAME_CONFIG_FIELD>>,
  AssertNever<Extract<(typeof LOBBY_ONLY_CONFIG_FIELD_LIST)[number], typeof MID_GAME_CONFIG_FIELD>>,
];

// 'disconnected' is deliberately excluded: it is server-owned (set in
// socketHandlers.handlePlayerLeave/joinRoom from actual socket connectivity,
// never from client input). Letting a push overwrite it let a stale roster
// snapshot — composed before a client saw a peer's disconnect, e.g. the
// active player's ~300ms live-dice pushState cadence — flip it back to
// false, permanently hiding the disconnected badge/kick button and
// corrupting host-failover ("prefer a connected player") until that seat's
// own reconnect-timeout timer or a manual kick removed it.
const PLAYER_MUTABLE: (keyof ServerPlayer)[] = [
  // Every counter a player accumulates, from the one list that also creates
  // them here and on the client (playerStats.ts). Spelling them out again was
  // how a stat came to be missing from this set — and a stat missing here is
  // not merely ignored, since a broadcast replaces the roster wholesale: it
  // is reset after every turn, for everyone.
  ...PLAYER_STAT_FIELDS,
  // All three per-turn maxima belong together: calculateNextTurn maintains
  // them side by side on the client, and a gameState broadcast replaces the
  // client's roster wholesale. Leaving the two per-card ones out meant they
  // were reset to undefined after every turn, so the "Highest Feuerwerk/x2
  // Turn" stats were always 0 for online games — in endGameStats, in the
  // global payload, in EndScreen's new-record cards and in the stats tiles.
  // They are not in that list because a player does not start a game on one:
  // "no turn yet" is undefined, not zero.
  'highestTurnScore', 'highestFeuerwerkTurnScore', 'highestX2TurnScore',
  // The classic-chain records follow the same "no value yet is undefined"
  // rule as the maxima above.
  'mostCardsInTurn', 'highestForfeitedTurnScore',
  'position', 'color',
];

/**
 * The PLAYER_MUTABLE entries whose "no value yet" is ABSENCE, not zero.
 *
 * They are absent from zeroedPlayerStats (a player does not start a game on a
 * per-turn maximum), so `createInitialPlayer` omits them and a Play Again
 * kickoff push carries no key for them. mergeMutable skips absent fields — its
 * whole point, so an ordinary mid-game push cannot wipe a record it merely
 * did not mention — which meant the merge onto the PREVIOUS game's server
 * player let last game's record survive into the new one. Since
 * calculateNextTurn only ever RAISES these, the new game's genuine record was
 * then never recorded at all: EndScreen and the stats tiles kept showing the
 * old number for the rest of the game.
 *
 * So absence has to mean two different things depending on the push, and only
 * a game start may read it as "cleared".
 */
const PLAYER_OPTIONAL_RECORDS: (keyof ServerPlayer)[] = [
  'highestTurnScore', 'highestFeuerwerkTurnScore', 'highestX2TurnScore',
  'mostCardsInTurn', 'highestForfeitedTurnScore',
];

// Matched by name, not deviceId: name is already unique within a room (enforced
// at join) and, unlike deviceId, was never meant to be secret — reorderPlayers
// already keys off it the same way. Keeping deviceId out of this match means it
// never has to round-trip through a broadcast (see sanitizePlayerForBroadcast).
export const validatePushedPlayers = (existing: ServerPlayer[], pushed: unknown[]): boolean => {
  if (!Array.isArray(pushed) || pushed.length !== existing.length) return false;
  const existingNames = new Set(existing.map(p => p.name));
  const pushedNames = pushed.map(p => (typeof p === 'object' && p !== null ? (p as { name?: string }).name : undefined) ?? '');
  // Two entries claiming the same name would both match the same existing
  // player in mergeMutable's name-keyed lookup — the first is applied, the
  // second silently ignored, and whichever other existing player that name
  // actually belongs to never gets its own pushed update applied at all.
  if (new Set(pushedNames).size !== pushedNames.length) return false;
  return pushed.every(p => typeof p === 'object' && p !== null && existingNames.has((p as { name?: string }).name ?? ''));
};

/**
 * The only PLAYER_MUTABLE fields one player's push may change on ANOTHER seat.
 *
 * A seated player is authorized to push on their own turn, and the merge below
 * used to apply every mutable field to every seat the push named — so one
 * player could rewrite the whole table's counters and records, bounded only by
 * MAX_SCORE_MAGNITUDE. The poison self-propagates, because the next honest
 * player re-pushes the roster it just synced, and it is finally committed by
 * each victim's OWN unmodified client at game end, which submits its own entry
 * for its own deviceId and is therefore accepted.
 *
 * These two are the whole legitimate cross-seat surface: the classic and
 * modernized Plus/Minus branches, and their undo, are the only places
 * coreGameEngine writes to a player other than the one taking the turn.
 */
const PLAYER_CROSS_SEAT_MUTABLE: (keyof ServerPlayer)[] = ['score', 'times1000PointsDeducted'];

const mergeMutable = (
  existing: ServerPlayer,
  p: Record<string, unknown> | undefined,
  // Only a game start may read an absent optional record as "cleared" — see
  // PLAYER_OPTIONAL_RECORDS. ownSeat false narrows the writable set to
  // PLAYER_CROSS_SEAT_MUTABLE; it defaults to true so the host path, which
  // legitimately rebuilds the whole roster, keeps its existing behaviour.
  { clearAbsentRecords = false, ownSeat = true }: { clearAbsentRecords?: boolean; ownSeat?: boolean } = {},
): ServerPlayer => {
  if (!p) return existing;
  const updated = { ...existing };
  const writable = ownSeat ? PLAYER_MUTABLE : PLAYER_CROSS_SEAT_MUTABLE;
  for (const f of writable) {
    if (!(f in p)) {
      if (clearAbsentRecords && PLAYER_OPTIONAL_RECORDS.includes(f)) {
        delete (updated as Record<string, unknown>)[f];
      }
      continue;
    }
    const v = p[f];
    if (f === 'color') {
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) updated.color = v;
      // Same sanity cap as previousScore/previousHighestTurnScore below — these
      // are counters and scores, never legitimately anywhere near this large,
      // and an unbounded value would ride every future broadcast to every client.
    } else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCORE_MAGNITUDE) {
      (updated as Record<string, unknown>)[f] = v;
    }
  }
  return updated;
};

// The context every field handler needs — the same reads/writes the old
// if/else chain closed over per branch, gathered in one place so a handler
// can be a plain function instead of an inline branch.
type ApplyContext = {
  state: RoomState;
  isHost: boolean;
  startingGame: boolean;
  // See applyPushedState's own parameter doc below: the seat the sender
  // occupies, captured before this push touched anything.
  pusherName: string | null;
};

// A field's whole accept-or-drop rule: validate `value` and, if it passes,
// write it onto ctx.state. An invalid value is dropped for this field only —
// the chain's silent per-field skip. The one case that discards the WHOLE
// push (a roster that is not a permutation of the seated players) is the
// roster gate in applyPushedState, which runs before the table is consulted.
type FieldHandler = (value: unknown, ctx: ApplyContext) => void;

const applyPlayers: FieldHandler = (value, ctx) => {
  const pushed = value as Record<string, unknown>[];
  // No permutation re-check here: the roster gate in applyPushedState already
  // refused anything that is not one (equal length, unique names, every name
  // known), so a surviving push's roster IS a strict permutation. A second
  // check would be dead code that reads as if non-permutations could reach
  // this handler.
  if (ctx.startingGame) {
    // Adopt the host's chosen ordering, but keep the server-side player
    // identities and non-mutable fields. Keeps chartNames/chartValues
    // (pushed in the same order) aligned with the authoritative roster.
    const byName = new Map(ctx.state.players.map(p => [p.name, p]));
    ctx.state.players = pushed.map(q =>
      mergeMutable(byName.get(q.name as string)!, q, { clearAbsentRecords: true }),
    );
  } else {
    ctx.state.players = ctx.state.players.map(existing =>
      mergeMutable(existing, pushed.find(q => q.name === existing.name), {
        ownSeat: ctx.isHost || existing.name === ctx.pusherName,
      }),
    );
  }
};

const applyWinningScore: FieldHandler = (value, ctx) => {
  if (isValidWinningScore(value)) ctx.state.winningScore = value;
};

// Keyed into FIELD_HANDLERS by MID_GAME_CONFIG_FIELD below, not the literal
// 'turnDuration', so the one field a running game may still change stays
// named in one place.
const applyTurnDuration: FieldHandler = (value, ctx) => {
  // Integers only: the loose >= 0 floor stays (integration tests push 1-2s
  // turns), but a SUB-SECOND duration would arm the 10ms-floor server timer
  // as a self-advancing loop that never ends the game. This is the one place
  // the push path is deliberately looser than isValidTurnDuration — every
  // other config field shares updateConfig's exact validator.
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TURN_DURATION) {
    ctx.state.turnDuration = value;
  }
};

const applyReconnectTimeout: FieldHandler = (value, ctx) => {
  // updateConfig's own validator, not merely the outer numeric bounds: 1..9
  // is the hole in the range (neither "disabled" nor an accepted duration),
  // the lobby snaps a typed value up out of it, and a pushed 3 used to land
  // and arm a 3-second kick timer no UI can produce.
  if (isValidReconnectTimeout(value)) ctx.state.reconnectTimeout = value;
};

const applyInitialCards: FieldHandler = (value, ctx) => {
  if (validateInitialCards(value)) ctx.state.initialCards = value;
};

const applyStatus: FieldHandler = (value, ctx) => {
  if (value === 'lobby' || value === 'playing') ctx.state.status = value;
};

const applyRandomOrder: FieldHandler = (value, ctx) => {
  if (typeof value === 'boolean') ctx.state.randomOrder = value;
};

// Shared by currentCard/previousCard: identical rule, only the target field
// differs. The double cast matches the chain's own workaround for writing
// through a key that is only known to be one of two fields of the same type.
const cardFieldHandler = (field: 'currentCard' | 'previousCard'): FieldHandler => (value, ctx) => {
  if (value === null || VALID_CARD_TYPES.includes(value as CardType)) {
    (ctx.state as unknown as Record<string, unknown>)[field] = value;
  }
};

const applyCards: FieldHandler = (value, ctx) => {
  if (Array.isArray(value) && value.length <= MAX_DECK_SIZE && value.every(c => VALID_CARD_TYPES.includes(c as CardType))) {
    ctx.state.cards = value as CardType[];
  }
};

const applyCurrentPlayerIndex: FieldHandler = (value, ctx) => {
  if (value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) < ctx.state.players.length)) {
    ctx.state.currentPlayerIndex = value as number | null;
  }
};

const applyRound: FieldHandler = (value, ctx) => {
  // MAX_ROUNDS is an array-length safety cap (chartLabels, historyLog), not a
  // bound on a legitimate round number — on its own it let an active player
  // push round: 100000 on their own turn. The honest host then submits that
  // as longestGameRounds, sanitizeStats' 1e9 cap waves it through, and the
  // column is MAX-merged into the global row forever.
  //
  // A game only ever nudges this: +1 when a round ends, the same value on
  // every other push, and -1 when a turn is undone across a round boundary.
  // The host is exempt because a Play Again kickoff resets it to 1.
  const withinReach = ctx.isHost || (value as number >= ctx.state.round - 1 && value as number <= ctx.state.round + 1);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ROUNDS && withinReach) {
    ctx.state.round = value;
  }
};

const applyFinished: FieldHandler = (value, ctx) => {
  // Both stats handlers take state.finished as proof a real game ended, and
  // their comments reason about the risk as host-only — but this is an
  // ACTIVE-player field. Any seated player could otherwise end the table's
  // game on their own turn; every honest client then submits, and each
  // victim's device row takes gamesPlayed + 1 with wins: 0, resetting their
  // win streak.
  //
  // The same condition calculateNextTurn and handleActivePlayerRemoved use,
  // against the roster this push has already merged ('players' runs before
  // 'finished' in ACTIVE_PLAYER_FIELD_LIST). A tie is not a win. Un-finishing
  // is never gated — that is what Play Again does. The host is exempt for the
  // same reason it is everywhere else here: it already writes every field via
  // ALL_FIELDS.
  if (typeof value !== 'boolean') return;
  const leaders = getLeaders(ctx.state.players);
  const gameIsOver = leaders.length === 1 && leaders[0].score >= ctx.state.winningScore;
  if (!value || ctx.isHost || gameIsOver) ctx.state.finished = value;
};

const applyPreviousScore: FieldHandler = (value, ctx) => {
  if (value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SCORE_MAGNITUDE)) {
    ctx.state.previousScore = value as number | null;
  }
};

const applyPreviousLeaders: FieldHandler = (value, ctx) => {
  if (value === null) {
    ctx.state.previousLeaders = null;
  } else if (Array.isArray(value) && value.length <= ctx.state.players.length && value.every(isPlausiblePlayerSnapshot)) {
    // Rebuilt from only the checked fields — isPlausiblePlayerSnapshot only
    // shape-checks name/score, so storing `value` as-is would let extra
    // properties on each entry ride along into every future broadcast.
    ctx.state.previousLeaders = value.map(p => ({ name: p.name, score: p.score })) as ServerPlayer[];
  }
};

const applyPreviousWasBust: FieldHandler = (value, ctx) => {
  if (typeof value === 'boolean') ctx.state.previousWasBust = value;
};

const applyPreviousWasSuccess: FieldHandler = (value, ctx) => {
  // A client predating this field omits the key entirely, so the loop skips
  // it and the room keeps what it had — which is exactly the "no outcome
  // recorded" state undo's fallback expects.
  if (typeof value === 'boolean') ctx.state.previousWasSuccess = value;
};

// The chain's three byte-identical branches, collapsed into one handler bound
// to whichever field it is guarding.
const boundedCounterHandler = (
  field: 'previousHighestTurnScore' | 'previousHighestFeuerwerkTurnScore' | 'previousHighestX2TurnScore',
): FieldHandler => (value, ctx) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SCORE_MAGNITUDE) {
    (ctx.state as unknown as Record<string, unknown>)[field] = value;
  }
};

const applyPreviousPlayerName: FieldHandler = (value, ctx) => {
  if (value === null || (typeof value === 'string' && value.length > 0 && value.length <= MAX_PLAYER_NAME_LENGTH)) {
    ctx.state.previousPlayerName = value as string | null;
  }
};

const applyPreviousTurnSummary: FieldHandler = (value, ctx) => {
  if (value === null) {
    ctx.state.previousTurnSummary = null;
  } else if (isValidTurnSummary(value)) {
    ctx.state.previousTurnSummary = sanitizeTurnSummary(value);
  }
};

const applyChartValues: FieldHandler = (value, ctx) => {
  if (
    Array.isArray(value) && isPerPlayerOrCleared(value, ctx.state.players) &&
    value.every(arr => Array.isArray(arr) && arr.length <= MAX_ROUNDS && arr.every(isBoundedNumber))
  ) {
    ctx.state.chartValues = value as number[][];
  }
};

const applyChartNames: FieldHandler = (value, ctx) => {
  // Entries are player names, so they follow the same 1-30 char rule as
  // previousPlayerName/historyLog.playerName. Without the length cap this was
  // the one client-pushed string stored unbounded — and rebroadcast to every
  // client on each subsequent emitRoomState.
  if (
    Array.isArray(value) && isPerPlayerOrCleared(value, ctx.state.players) &&
    value.every(n => typeof n === 'string' && n.length > 0 && n.length <= MAX_PLAYER_NAME_LENGTH)
  ) {
    ctx.state.chartNames = value as string[];
  }
};

const applyChartLabels: FieldHandler = (value, ctx) => {
  // Round numbers: whole, and bounded like every other pushed numeric.
  if (Array.isArray(value) && value.length <= MAX_ROUNDS && value.every(n => Number.isInteger(n) && isBoundedNumber(n))) {
    ctx.state.chartLabels = value as number[];
  }
};

const applyGameTimeInSeconds: FieldHandler = (value, ctx) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_GAME_SECONDS) {
    ctx.state.gameTimeInSeconds = value;
  }
};

const applyLiveTurnState: FieldHandler = (value, ctx) => {
  if (value === null) {
    ctx.state.liveTurnState = null;
  } else if (isValidDiceSnapshot(value)) {
    ctx.state.liveTurnState = sanitizeDiceSnapshot(value);
  }
};

const applyEnforcedDiceMode: FieldHandler = (value, ctx) => {
  if (isValidEnforcedDiceMode(value)) ctx.state.enforcedDiceMode = value;
};

const applyRuleset: FieldHandler = (value, ctx) => {
  // The mid-game refusal lives in LOBBY_ONLY_CONFIG_FIELDS now, with the rest
  // of the config. It matters most here: flipping the rule set under an
  // active game changes the turn logic on every client mid-turn, and the
  // normalizedGame-style sticky downgrade cannot help — it protects the
  // stats label, not gameplay.
  if (isValidRuleset(value)) ctx.state.ruleset = value;
};

const applyHistoryLog: FieldHandler = (value, ctx) => {
  if (Array.isArray(value) && value.length <= MAX_HISTORY_LOG_SIZE && value.every(isValidHistoryEntry)) {
    ctx.state.historyLog = value.map(sanitizeHistoryEntry);
  }
};

/**
 * One handler per synced field, replacing the if/else chain that used to
 * dispatch on `key`.
 *
 * `satisfies Record<SyncedGameStateKey, FieldHandler>` is the old chain's
 * terminal `else` (assertHandled), moved to compile time: every key in the
 * canonical SyncedGameStateKey union must have an entry here, the same way
 * PushFieldLock forces every key onto one of the two allowlists below. A
 * synced key added without a handler now fails the build naming the missing
 * property, instead of silently falling through a chain with no `else` — the
 * exact defect class this table (and PushFieldLock beside it) exists to make
 * impossible. Verified by mutation: temporarily add a field to
 * SyncedGameStateKey (src/types.ts) with no matching entry here and tsc fails
 * on this table; remove it again afterwards.
 */
const FIELD_HANDLERS = {
  status: applyStatus,
  winningScore: applyWinningScore,
  initialCards: applyInitialCards,
  randomOrder: applyRandomOrder,
  [MID_GAME_CONFIG_FIELD]: applyTurnDuration,
  reconnectTimeout: applyReconnectTimeout,
  enforcedDiceMode: applyEnforcedDiceMode,
  ruleset: applyRuleset,
  currentCard: cardFieldHandler('currentCard'),
  cards: applyCards,
  currentPlayerIndex: applyCurrentPlayerIndex,
  round: applyRound,
  previousCard: cardFieldHandler('previousCard'),
  previousScore: applyPreviousScore,
  previousLeaders: applyPreviousLeaders,
  previousWasBust: applyPreviousWasBust,
  previousWasSuccess: applyPreviousWasSuccess,
  previousHighestTurnScore: boundedCounterHandler('previousHighestTurnScore'),
  previousHighestFeuerwerkTurnScore: boundedCounterHandler('previousHighestFeuerwerkTurnScore'),
  previousHighestX2TurnScore: boundedCounterHandler('previousHighestX2TurnScore'),
  previousPlayerName: applyPreviousPlayerName,
  previousTurnSummary: applyPreviousTurnSummary,
  chartValues: applyChartValues,
  chartNames: applyChartNames,
  chartLabels: applyChartLabels,
  gameTimeInSeconds: applyGameTimeInSeconds,
  players: applyPlayers,
  finished: applyFinished,
  liveTurnState: applyLiveTurnState,
  historyLog: applyHistoryLog,
} satisfies Record<SyncedGameStateKey, FieldHandler>;

// Merges a client-pushed state snapshot into the authoritative room state,
// field by field: fields outside the sender's permission set are skipped, and
// every accepted value must pass its shape/bounds check — anything else is
// silently ignored so a malformed or malicious push can never corrupt server
// state. Pure state-in/state-out (no io, no timers) so it can be unit-tested.
//
// Returns whether the snapshot was applied at all. Individual fields are still
// dropped silently (that is the point of the checks above); false means only
// the wholesale bail-out below fired, and the caller's own "this push started a
// game" bookkeeping must not run for a push that changed nothing.
export const applyPushedState = (
  state: RoomState,
  newState: Record<string, unknown>,
  {
    isHost,
    startingGame,
    pusherName,
  }: {
    isHost: boolean;
    startingGame: boolean;
    // The seat the sender occupies, read by the caller BEFORE this function
    // mutates anything — currentPlayerIndex is itself a pushable field, so
    // re-deriving it inside the loop below would read a value the same push
    // had already moved. Required rather than optional: a non-host push may
    // only write PLAYER_CROSS_SEAT_MUTABLE on other seats, and a defaulted
    // value would fail open. null means "no seat", which is treated as
    // strictly as a foreign one. The host path ignores it.
    pusherName: string | null;
  },
): boolean => {
  const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

  // Kept for the coherence check after the loop. Both, not just the index:
  // the incoherent combination can be reached by moving EITHER field, so a
  // push that supplies no index to go back to must give up its status change
  // instead. The pre-push state is coherent by induction, so restoring the
  // pair always lands somewhere valid.
  const statusBeforePush = state.status;
  const playerIndexBeforePush = state.currentPlayerIndex;

  // Read from the PRE-push status, never from state.status inside the loop:
  // 'status' is the first Set entry and has already been overwritten by the
  // time later keys apply. Play Again is why `startingGame` is the other half
  // — it never passes through the lobby, so the room is still 'playing' with
  // finished=true when the host pushes the next game's opening config.
  const allowConfigWrite = startingGame || statusBeforePush === 'lobby';

  // A push is one snapshot of one moment, and its roster is what dates it: a
  // seat spliced out (a leave, a kick, a reconnect timeout) between the client
  // composing this and the server receiving it makes the WHOLE snapshot
  // describe a table that no longer exists. Skipping only `players` and
  // applying the rest let the turn advance and be logged from a push whose
  // banked score had just been thrown away — the points were simply lost, and
  // the next broadcast then overwrote the client with the scoreless roster, so
  // nothing corrected it. The sender re-derives from that broadcast instead.
  if ('players' in newState && !validatePushedPlayers(state.players, newState.players as unknown[])) {
    return false;
  }

  const ctx: ApplyContext = { state, isHost, startingGame, pusherName };
  for (const key of allowedFields) {
    if (!(key in newState)) continue;
    // One check for the whole config set rather than a condition repeated in
    // six branches, which is how five of them came to be missing it.
    if (!allowConfigWrite && LOBBY_ONLY_CONFIG_FIELDS.has(key)) continue;
    FIELD_HANDLERS[key](newState[key], ctx);
  }

  // A running game must always have someone to act. `null` is a legal value —
  // it is what the winning push carries — but only alongside the finish that
  // explains it. On its own it strands the room for good: pushState's
  // timer-restart branch requires a non-null index and its teardown branch
  // requires finished-or-lobby, so the server arms no new expiry AND clears
  // none, and the pending one returns early on every later fire. The room then
  // reads as a lobby to every client while the server still counts it as a
  // game in progress — and the host's next Start satisfies neither
  // `startingGame` disjunct (the status is already 'playing' and finished is
  // already false), so the stats dedup is never reset and the normalizedGame /
  // ruleset freeze never re-runs for the new game.
  //
  // Checked after the loop rather than in the `currentPlayerIndex` branch,
  // because the three fields it spans are applied at three different points
  // in it: 'status' is first, 'currentPlayerIndex' third, 'finished'
  // twentieth. No legitimate push produces this combination — a game ending
  // sets `finished`, and one being torn down sets status 'lobby'. (roomPhase
  // reads status+finished together here; the repair below still WRITES both
  // fields directly, same as ever.)
  if (roomPhase(state) === 'playing' && state.currentPlayerIndex === null) {
    state.currentPlayerIndex = playerIndexBeforePush;
    if (state.currentPlayerIndex === null) state.status = statusBeforePush;
  }

  return true;
};
