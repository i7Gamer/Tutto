import { MAX_HISTORY_LOG_SIZE, MAX_CHAIN_CARDS, HISTORY_EVENT_TYPES, type CardType, type InitialCards, type DiceSnapshot, type HistoryEntry, type TurnSummary, type TurnCardPlayed } from '../src/types';
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
  MAX_SCORE_MAGNITUDE, MAX_ROUNDS, MAX_CHART_POINTS, MAX_GAME_SECONDS,
} from '../src/utils/configValidation';
import { PLAYER_STAT_FIELDS, PLAYER_NUMERIC_FIELDS, PLAYER_RECORD_FIELDS, type PlayerStatField, type PlayerRecordField } from '../src/utils/playerStats';
import { getLeaders } from '../src/utils/coreGameEngine';
import { roomPhase } from '../src/utils/roomPhase';
import type { SyncedGameStateKey, AssertNever, ConfigKeys } from '../src/types';
import type { RoomState, ServerPlayer } from './roomTypes';

// A fully-loaded deck has at most MAX_CARD_COUNT of each of the 11 card
// types. Exported for pushStateValidation.test.ts's maximal-state size
// measurement (see socketLimits.ts).
export const MAX_DECK_SIZE = MAX_CARD_COUNT * 11;
// Re-exported (not redefined) so rooms.ts, turnTimers.ts and this file's own
// tests can keep importing them from here — the real definitions live in
// src/utils/configValidation.ts. MAX_SCORE_MAGNITUDE is shared with the
// client's own score clamp (diceTurnControls.ts's parseScoreInput), which is
// what keeps the two ceilings from drifting apart the way they used to (the
// client allowed a 7-digit box up to 9,999,999 while this bound was
// 1,000,000).
//
// MAX_GAME_SECONDS used to be re-exported alongside them, on the stated
// grounds that server/sanitize.ts needed it — but sanitize.ts takes all three
// straight from configValidation (which is what avoids dragging this file's
// coreGameEngine ↔ statsPayloads cycle into server/api.ts's module graph), and
// nothing imported it from here at all. Dropped rather than left as a second
// name for the same constant.
export { MAX_SCORE_MAGNITUDE, MAX_ROUNDS, MAX_CHART_POINTS };
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
  // Bounded, not merely finite, like every other numeric in this file:
  // turnTimers reads turnScore straight into the timed-out player's
  // highestForfeitedTurnScore, which their own unmodified client then submits
  // for their device — where the DB merges it with MAX, permanently. The
  // liveTurnState handler is the ACTIVE player's alone now (it used to accept
  // `isHost || isActivePlayer`, which let a patched host aim that at someone
  // else), so this bounds what a player can do to their OWN record — and the
  // pushState path, which still admits both, reaches the same field.
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

  if (!(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= MAX_HISTORY_ID_LENGTH)) return false;
  if (!(typeof entry.round === 'number' && Number.isInteger(entry.round) && entry.round >= 1 && entry.round <= MAX_ROUNDS)) return false;
  if (!(typeof entry.playerName === 'string' && entry.playerName.length > 0 && entry.playerName.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  if (entry.playerColor !== undefined && !(typeof entry.playerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.playerColor))) return false;
  if (!(typeof entry.card === 'string' && (VALID_CARD_TYPES as readonly string[]).includes(entry.card))) return false;
  // Derived from src/types.ts's HISTORY_EVENT_TYPES rather than a hand-rolled
  // copy — a kind added there (like 'timeout') used to type-check everywhere
  // while this validator silently rejected it off the wire.
  if (!(typeof entry.type === 'string' && (HISTORY_EVENT_TYPES as readonly string[]).includes(entry.type))) return false;
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
  'currentPlayerIndex', 'round',
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

/**
 * The synced fields NO push may write, because the server produces them
 * itself — see applyServerOwnedField below for what that buys and why an
 * arriving value is dropped rather than refused.
 *
 * A third list rather than "just leave them out of both": PushFieldLock has
 * always forced every synced field onto an allowlist precisely so that one
 * silently missing from both fails the build instead of being silently
 * stripped from every push. Making the exception a WRITTEN list keeps that
 * guarantee — the same shape BROADCAST_EXCLUDED_FIELDS (server/rooms.ts) and
 * NeverSavedLocally (src/store/persistence.ts) already have on their sides.
 *
 * Exported so this file's own tests can assert the property over the LIST
 * rather than over two field names hard-coded beside it, which would not grow
 * with it — the same reason BROADCAST_EXCLUDED_FIELDS is exported.
 */
export const SERVER_OWNED_FIELD_LIST = [
  'currentCard', 'cards',
] as const satisfies readonly SyncedGameStateKey[];

// The three lists must partition the synced game state: together they cover
// every synced field, and no field sits in more than one. A field missing from
// all of them was this codebase's most common defect — applyPushedState loops
// the allowlist, not the payload, so the field was silently stripped from every
// push with nothing failing. Now it refuses to build, naming the key.
//
// Membership is only half of it, and this lock used to be described as if it
// were the whole: a key can sit in an allowlist and still have no branch in
// the dispatch chain below, which drops it just as silently. That half is
// covered by the chain's terminal `else` (assertHandled), not here.
// Exported only so noUnusedLocals sees a use; nothing imports it.
export type PushFieldLock = [
  AssertNever<Exclude<SyncedGameStateKey,
    (typeof HOST_ONLY_FIELD_LIST)[number] | (typeof ACTIVE_PLAYER_FIELD_LIST)[number] | (typeof SERVER_OWNED_FIELD_LIST)[number]>>,
  AssertNever<Extract<(typeof HOST_ONLY_FIELD_LIST)[number], (typeof ACTIVE_PLAYER_FIELD_LIST)[number]>>,
  // A server-owned field in either writable set would hand the deck straight
  // back to the client this whole split exists to take it from.
  AssertNever<Extract<(typeof SERVER_OWNED_FIELD_LIST)[number],
    (typeof HOST_ONLY_FIELD_LIST)[number] | (typeof ACTIVE_PLAYER_FIELD_LIST)[number]>>,
];

const ALL_FIELDS: ReadonlySet<SyncedGameStateKey> =
  Object.freeze(new Set<SyncedGameStateKey>([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]));

// The config a running game must not have changed underneath it — the same set
// updateConfig refuses mid-game (socketConfigHandlers.ts), enforced here too
// because pushState reaches every one of these fields. winningScore is
// validated with the real isValidWinningScore (see the dedicated branch
// below), so it enforces exactly the same rule as updateConfig; a looser
// check here would make pushState a side door for a winning score updateConfig
// had just rejected. The other fields have their own handlers in FIELD_HANDLERS
// with their own validation rules.
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
// socketRoomHandlers.handlePlayerLeave/joinRoom from actual socket connectivity,
// never from client input). Letting a push overwrite it let a stale roster
// snapshot — composed before a client saw a peer's disconnect, e.g. the
// active player's ~300ms live-dice pushState cadence — flip it back to
// false, permanently hiding the disconnected badge/kick button and
// corrupting host-failover ("prefer a connected player") until that seat's
// own reconnect-timeout timer or a manual kick removed it.
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
 * a game start may read it as "cleared". Derived from PLAYER_RECORD_FIELDS
 * (playerStats.ts) rather than spelled out here a second time — the same
 * derivation PLAYER_MUTABLE's own stat-field spread already uses just below,
 * and for the same reason: a hand-copied list is exactly how a record fell
 * out of PLAYER_MUTABLE entirely before the maxima were let in.
 */
const PLAYER_OPTIONAL_RECORDS: (keyof ServerPlayer)[] = [...PLAYER_RECORD_FIELDS];

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
  // Derived from PLAYER_OPTIONAL_RECORDS just above rather than spelled out
  // here a second time, so the two copies — and the client's own
  // PLAYER_RECORD_FIELDS — cannot drift apart the way they used to.
  ...PLAYER_OPTIONAL_RECORDS,
  'position', 'color',
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
 * These two are the whole legitimate cross-seat surface for a turn being
 * PLAYED: the classic and modernized Plus/Minus branches are the only places
 * coreGameEngine writes to a player other than the one taking the turn. A turn
 * being UNDONE reaches further, onto one specific other seat — see
 * PLAYER_UNDO_SEAT_MUTABLE.
 */
const PLAYER_CROSS_SEAT_MUTABLE: (keyof ServerPlayer)[] = ['score', 'times1000PointsDeducted'];

/**
 * What a non-host push may write on the seat an undo hands the turn back to.
 *
 * calculateUndo (src/utils/coreGameEngine.ts) does not rewind the pusher's own
 * turn — it rewinds the one BEFORE it, onto the seat that played it: that
 * seat's totalTurns, every counter revertSummaryCounters and
 * revertModernizedCounters walk back (busts, the per-card counters, tuttos),
 * and the per-turn records whose pre-turn values the summary stashed. All of
 * that fell outside PLAYER_CROSS_SEAT_MUTABLE once the turn had advanced, so
 * only the score came back and every counter was silently dropped — the
 * replayed turn then counted each of them a second time, and the doubled row
 * was finally committed by that victim's OWN unmodified client at game end.
 *
 * `position` and `color` are the only PLAYER_MUTABLE entries left out: no undo
 * path writes either, and they are presentation rather than the turn
 * bookkeeping an undo has to reverse.
 *
 * Handed out only on a push SHAPED like an undo — see looksLikeUndo in
 * applyPlayers. Granting it unconditionally let EVERY push from the active
 * seat rewrite one other seat's whole stat row.
 *
 * The shape alone is not enough at two seats, where the predecessor IS the
 * successor and an ordinary hand-over satisfies it for free: mergeMutable's
 * `undoDirectionOnly` additionally refuses any field here (other than
 * PLAYER_CROSS_SEAT_MUTABLE, exempt below) whose pushed value exceeds what
 * the seat already holds — a genuine undo only ever lowers or restores these,
 * never raises them.
 */
const PLAYER_UNDO_SEAT_MUTABLE: (keyof ServerPlayer)[] = [
  ...PLAYER_STAT_FIELDS,
  ...PLAYER_OPTIONAL_RECORDS,
];

/**
 * The one mutable player number that may legitimately be below zero.
 *
 * Every other number a player carries counts upward from zero — the stat
 * counters, the two point sums, and the per-turn records, which are only ever
 * written when they BEAT zero (NO_RECORD_YET in coreGameEngine). The score is
 * different: the modernized Plus/Minus deducts 1000 from each leader, so a
 * player who has not banked that much ends the turn negative, and the engine's
 * own tests pin that. Refusing a negative score here would reset that player
 * to whatever the server last held on every push for the rest of the game.
 */
const SIGNED_PLAYER_FIELD = 'score';

const PLAYER_NON_NEGATIVE_FIELDS: ReadonlySet<keyof ServerPlayer> = Object.freeze(
  new Set<keyof ServerPlayer>(PLAYER_NUMERIC_FIELDS.filter(f => f !== SIGNED_PLAYER_FIELD)),
);

// Locks the exemption to a field that is actually one of the numbers it is
// carved out of. Without it a renamed `score` would leave the set unchanged
// and silently make the real score field non-negative too — the same silence
// PushFieldLock exists to prevent one list up.
// Exported only so noUnusedLocals sees a use; nothing imports it.
export type SignedPlayerFieldLock =
  AssertNever<Exclude<typeof SIGNED_PLAYER_FIELD, PlayerStatField | PlayerRecordField>>;

// What a pushed player number has to be: bounded like every other pushed
// number, WHOLE (no game produces 2.5 busts or half a point), and at or above
// zero unless it is the score. `busts: 2.5` and `totalTurns: -7` used to be
// accepted on nothing but finiteness and the magnitude cap — then broadcast to
// the room, and finally carried into the stats payload each client submits at
// game end, whose own bound is a magnitude too.
const isMergeablePlayerNumber = (field: keyof ServerPlayer, v: unknown): v is number =>
  isBoundedNumber(v) && Number.isInteger(v) && (v >= 0 || !PLAYER_NON_NEGATIVE_FIELDS.has(field));

const mergeMutable = (
  existing: ServerPlayer,
  p: Record<string, unknown> | undefined,
  // Only a game start may read an absent optional record as "cleared" — see
  // PLAYER_OPTIONAL_RECORDS. `writable` is the field set THIS push may write
  // on THIS seat; it defaults to the full one so the host path and the
  // game-start path, which legitimately rebuild the whole roster, keep their
  // existing behaviour.
  //
  // `undoDirectionOnly` is true exactly when `writable` is
  // PLAYER_UNDO_SEAT_MUTABLE — see applyPlayers. It does not change WHICH
  // fields are writable, only which values within them are accepted: a
  // property probe over >= 2000 random (state, turn, undo) trials
  // (scratch/r12-f3-undo-monotone.test.ts) confirms calculateUndo
  // (src/utils/coreGameEngine.ts) never raises any PLAYER_UNDO_SEAT_MUTABLE
  // field, on the seat it hands the turn back to, above what that seat held
  // the moment the turn it undoes had just committed — a real undo only ever
  // walks a counter back (Math.max(0, current - 1)) or restores a record to
  // a stashed pre-turn value, which was never higher than what the forward
  // turn set. So refusing a pushed value that EXCEEDS the seat's CURRENT
  // (existing) value costs a genuine undo nothing, while it caps what the
  // shape check alone let through: an attacker satisfying looksLikeUndo could
  // still set every counter to any value <= what is already there (no gain)
  // or below it (which every other cross-seat write already tolerates), but
  // can no longer inflate one.
  { clearAbsentRecords = false, writable = PLAYER_MUTABLE, undoDirectionOnly = false }:
    { clearAbsentRecords?: boolean; writable?: (keyof ServerPlayer)[]; undoDirectionOnly?: boolean } = {},
): ServerPlayer => {
  if (!p) return existing;
  const updated = { ...existing };
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
      // `position` is not one of the numbers PLAYER_NON_NEGATIVE_FIELDS covers
      // (it is a seat index, not a tally), but it is still a whole number.
    } else if (isMergeablePlayerNumber(f, v)) {
      // `score` and `times1000PointsDeducted` are exempt: PLAYER_CROSS_SEAT_MUTABLE
      // already hands them out on every OTHER foreign seat too, unconditionally
      // and in both directions (a Plus/Minus resolving on the pusher's own turn
      // can raise or lower either on any seat it touches) — the undo grant
      // widens nothing for these two, so gating them here would only refuse a
      // write every other foreign-seat push already allows unchecked.
      //
      // Absent-existing reads as -Infinity, not 0: the probe above found no
      // legitimate undo push that ever needs to WRITE a still-absent field a
      // defined value under this grant (restoring a record to "no value yet"
      // omits the key rather than sending a number, and the `!(f in p)` branch
      // above already leaves that alone) — so there is no push this direction
      // could wrongly refuse, while reading it as 0 would let an attacker plant
      // a first value on a record this seat has never touched.
      if (undoDirectionOnly && !PLAYER_CROSS_SEAT_MUTABLE.includes(f)
        && v > ((existing as Record<string, unknown>)[f] as number | undefined ?? Number.NEGATIVE_INFINITY)) {
        continue;
      }
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
  // The RAW snapshot this push carries, so a handler can read a sibling field
  // as the sender SENT it. ctx.state is not a substitute: by the time a late
  // handler runs, an earlier one has already written its field onto the state
  // — or silently dropped it for failing its own check — so reading it back
  // there answers "what the room now holds", not "what this push claimed".
  // applyPlayers needs the latter to tell an undo from an ordinary turn.
  pushedState: Record<string, unknown>;
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
    // The pusher's seat and the seat their undo reaches, both read off the
    // ROSTER rather than off the payload. previousPlayerName names the same
    // player and would be the obvious key, but it is itself a pushable field:
    // an attacker plants a victim's name in one push and writes that victim's
    // counters in the next, twenty times a second (PUSH_STATE_LIMIT). A
    // non-host push is authorized only from the ACTIVE seat, so the pusher's
    // own index IS the turn's index and "the seat before mine" is the previous
    // player by construction — with nothing in the payload able to aim it.
    const seats = ctx.state.players;
    const pusherIdx = ctx.pusherName === null ? -1 : seats.findIndex(p => p.name === ctx.pusherName);
    // Wrapping, because the first seat's predecessor is the last one — that is
    // the undo that also unwinds the round. At a single seat it resolves to
    // the pusher themselves, which grants nothing they did not already have.
    const undoSeatIdx = pusherIdx === -1 ? -1 : (pusherIdx - 1 + seats.length) % seats.length;

    // Whether this push is even claiming to BE an undo. Nothing used to ask:
    // the wider set was handed to the predecessor's seat on every push from
    // the active player, so — twenty times a second, under PUSH_STATE_LIMIT —
    // that player could rewrite one other seat's score, busts, totalTurns,
    // every per-card counter and every per-turn record. In a two-player game
    // the predecessor is always the opponent, and the poisoned row is finally
    // committed by that opponent's OWN unmodified client at game end.
    //
    // The two halves are what src/store/gameSlice.ts's `undo` writes together:
    // calculateUndo hands the turn back to the seat that played it
    // (currentPlayerIndex becomes that seat), and Object.assign(state,
    // noUndoableTurn()) nulls previousCard in the same set. pushState always
    // sends the whole synced field set, so both reach the server on any real
    // undo. Read off the PUSH rather than off ctx.state: applyCurrentPlayerIndex
    // and the previousCard handler have already run by the time this does, and
    // either may have dropped its value — which would silently re-widen this.
    //
    // A narrowing, not a seal. An attacker can still satisfy the shape; what
    // it costs them is the turn (handed to the very seat they are writing) and
    // their own undo state, on every push that carries the wider set. That
    // turns an unlimited free-running write into one that gives up the table.
    //
    // At exactly two seats the predecessor IS the successor, so an ordinary
    // hand-over (previousCard: null, currentPlayerIndex pointing at the only
    // other seat) satisfies this shape for free — the turn/undo-state "cost"
    // above is nothing at two seats. `undoDirectionOnly` below (mergeMutable)
    // closes that: an undo only ever WALKS a counter BACK or RESTORES a
    // record to its stashed pre-turn value, so a two-seat attacker can still
    // satisfy the shape but can no longer inflate anything — only lower it,
    // which every other cross-seat write already tolerates.
    const looksLikeUndo = ctx.pushedState.currentPlayerIndex === undoSeatIdx
      && ctx.pushedState.previousCard === null;

    ctx.state.players = seats.map((existing, i) =>
      mergeMutable(existing, pushed.find(q => q.name === existing.name), {
        writable: ctx.isHost || i === pusherIdx
          ? PLAYER_MUTABLE
          : (looksLikeUndo && i === undoSeatIdx ? PLAYER_UNDO_SEAT_MUTABLE : PLAYER_CROSS_SEAT_MUTABLE),
        undoDirectionOnly: looksLikeUndo && i === undoSeatIdx,
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

// previousCard only, now that currentCard is dealt by the server and no longer
// writable from a push. It stays a bookkeeping field: which card the turn that
// can still be undone was played on.
const applyPreviousCard: FieldHandler = (value, ctx) => {
  if (value === null || VALID_CARD_TYPES.includes(value as CardType)) {
    ctx.state.previousCard = value as CardType | null;
  }
};

/**
 * The two fields the SERVER deals, ignored wherever they arrive.
 *
 * `cards` is the ordered undrawn deck and `currentCard` is the card in play.
 * A client that can write either one picks its own next card — which in the
 * classic rule set is the entire game, since the decision the whole turn turns
 * on is "bank what you are holding, or reveal the next card and risk it". Both
 * are dealt by server/deckAuthority.ts now, from the move a merged push
 * implies, so the card is chosen AFTER the player has committed to drawing.
 *
 * Kept as entries in FIELD_HANDLERS rather than deleted, because that table is
 * locked to the canonical synced-field set (`satisfies Record<SyncedGameStateKey,
 * FieldHandler>`) — a synced field with no entry fails the build. They are
 * unreachable in practice: neither field is in HOST_ONLY_FIELDS or
 * ACTIVE_PLAYER_FIELDS, and applyPushedState loops those sets rather than the
 * payload. This is the belt to that braces, and it is what documents at the
 * dispatch table itself why the two keys look absent from both allowlists.
 *
 * Ignoring rather than REFUSING the push that carries them is deliberate and
 * is what lets this ship on its own: there is no protocol version here, an
 * in-room client is never updated across a redeploy (swUpdate.ts), and every
 * client predating this change sends both fields on every single push.
 * Refusing those would end every game in progress.
 */
const applyServerOwnedField: FieldHandler = () => {};

const applyCurrentPlayerIndex: FieldHandler = (value, ctx) => {
  if (value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) < ctx.state.players.length)) {
    ctx.state.currentPlayerIndex = value as number | null;
  }
};

const applyRound: FieldHandler = (value, ctx) => {
  // MAX_ROUNDS is an array-length safety cap (chartLabels, historyLog), not a
  // bound on a legitimate round number — on its own it let an active player
  // push round: 100000 on their own turn. The honest host then submits that
  // as longestGameRounds, and sanitize.ts' own MAX_ROUNDS cap (the same
  // constant, not a separate 1e9 one) waves it through, so the column is
  // MAX-merged into the global row forever.
  //
  // A game only ever nudges this: +1 when a round ends, the same value on
  // every other push, and -1 when a turn is undone across a round boundary.
  // The host gets exactly one thing more than that: a standing allowance to
  // reset it to 1. Both real resets are 1 — a Play Again / lobby kickoff
  // (gameSlice.startGame) and the host-only "End Game" (gameSlice.endGame,
  // which tears a running game down to the lobby with `round: 1` but
  // startingGame false, since its push never carries status: 'playing') —
  // and both must land after a long game has pushed `round` well out of ±1
  // reach. Dropping to 1 is harmless: 1 can only ever LOWER a MAX-merged
  // longestGameRounds record and adds at most 1 to a SUM-merged
  // totalRoundsSum. Nothing wider, not even at a kickoff: a blanket host
  // exemption let a mid-game host push (or a hand-built one impersonating the
  // host) set round: MAX_ROUNDS in one hop, and a kickoff-only exemption would
  // still let a kickoff open the game at round 99990.
  const withinReach = (ctx.isHost && value === 1) ||
    (typeof value === 'number' && value >= ctx.state.round - 1 && value <= ctx.state.round + 1);
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
  // 'finished' in ACTIVE_PLAYER_FIELD_LIST). A tie is not a win.
  //
  // The HOST is held to it too, unlike everywhere else in this file. The
  // exemption it used to have was the one place a two-winner verdict could
  // get in: rooms.ts freezes room.finishedGame from getLeaders() the first
  // moment the room reports itself finished, so a host-pushed tie handed BOTH
  // leaders a win and a fastestWinTurns, neither of which any later
  // correction can take back. The host owning every field is not a reason to
  // let it assert an outcome the engine cannot produce.
  //
  // Nothing legitimate needs the exemption: the only explicit early end the UI
  // offers (GameControls' host-only "End Game" -> gameSlice.endGame) pushes
  // finished: FALSE with status 'lobby', and so does Play Again. Un-finishing
  // is never gated, so both keep working — see the coherence repair in
  // applyPushedState for the one un-finish that is still refused.
  if (typeof value !== 'boolean') return;
  const leaders = getLeaders(ctx.state.players);
  const gameIsOver = leaders.length === 1 && leaders[0].score >= ctx.state.winningScore;
  if (!value || gameIsOver) ctx.state.finished = value;
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
  // MAX_CHART_POINTS bounds the series LENGTH (one entry per completed
  // round), not a round number — see its definition in configValidation.ts.
  if (
    Array.isArray(value) && isPerPlayerOrCleared(value, ctx.state.players) &&
    value.every(arr => Array.isArray(arr) && arr.length <= MAX_CHART_POINTS && arr.every(isBoundedNumber))
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
  // Entries are round numbers (whole, bounded like every other pushed
  // numeric), but the ARRAY LENGTH is capped by MAX_CHART_POINTS, not
  // MAX_ROUNDS — the length is a datapoint count (one per completed round),
  // not itself a round number.
  if (Array.isArray(value) && value.length <= MAX_CHART_POINTS && value.every(n => Number.isInteger(n) && isBoundedNumber(n))) {
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
  currentCard: applyServerOwnedField,
  cards: applyServerOwnedField,
  currentPlayerIndex: applyCurrentPlayerIndex,
  round: applyRound,
  previousCard: applyPreviousCard,
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
    // had already moved. Required rather than optional: it is what applyPlayers
    // narrows every other seat against (PLAYER_CROSS_SEAT_MUTABLE, or
    // PLAYER_UNDO_SEAT_MUTABLE for the one seat before it), and a defaulted
    // value would fail open. null means "no seat", which is treated as
    // strictly as a foreign one — and names no predecessor either. The host
    // path ignores it. (The predecessor only gets the wider set on a push
    // shaped like an undo; see looksLikeUndo in applyPlayers.)
    pusherName: string | null;
  },
): boolean => {
  const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

  // Kept for the coherence check after the loop. All three, not just the
  // index: the incoherent combination can be reached by moving ANY of them, so
  // a push that supplies no index to go back to must give up its status change
  // instead, and one whose status was already 'playing' must give up its
  // `finished` change. The pre-push state is coherent by induction, so
  // restoring the three always lands somewhere valid.
  const statusBeforePush = state.status;
  const playerIndexBeforePush = state.currentPlayerIndex;
  const finishedBeforePush = state.finished;

  // Kept for the chartLabels/chartValues coherence check after the loop —
  // same reasoning as the trio above: applyChartLabels and applyChartValues
  // validate independently, so a push naming one without the other (or both,
  // out of step) can leave the pair incoherent, and reverting BOTH to their
  // pre-push values is the repair that is always valid by induction.
  const chartLabelsBeforePush = state.chartLabels;
  const chartValuesBeforePush = state.chartValues;

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

  const ctx: ApplyContext = { state, isHost, startingGame, pusherName, pushedState: newState };
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
    // Both fallbacks above are no-ops for the third way in: a FINISHED game
    // is status 'playing' / finished true / currentPlayerIndex null, so a push
    // that only clears `finished` had no index to go back to and no status
    // change to give up — and the repair handed back the very state it was
    // checking. Giving up the un-finish instead is the one move left, and it
    // is the right one: the legitimate un-finish is Play Again, which names
    // the first player in the same push and never reaches here.
    if (roomPhase(state) === 'playing' && state.currentPlayerIndex === null) {
      state.finished = finishedBeforePush;
    }
  }

  // chartLabels is round-indexed and chartValues is player-indexed, so a
  // coherent chart has the two the same length (chartValues[0], since every
  // player's series is appended to in lockstep — see rooms.ts/turnTimers.ts's
  // own appends). applyChartLabels and applyChartValues each validate
  // independently, so a push naming one without the other (or both, out of
  // step) sails through both handlers above even though the pair it leaves
  // behind is one no legitimate client ever produces. Only checked once BOTH
  // are non-empty — an empty trio (endGame's own clearing push) is coherent
  // by definition, and a fresh room starts with both empty.
  if (state.chartLabels.length > 0 && state.chartValues.length > 0
      && state.chartLabels.length !== state.chartValues[0]?.length) {
    state.chartLabels = chartLabelsBeforePush;
    state.chartValues = chartValuesBeforePush;
  }

  return true;
};
