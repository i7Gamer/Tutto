import { MAX_HISTORY_LOG_SIZE, MAX_CHAIN_CARDS, type CardType, type InitialCards, type DiceSnapshot, type HistoryEntry, type TurnSummary, type TurnCardPlayed } from '../src/types';
import {
  isSnapshotDie, isRolledDie, isKniffelProgressEntry, isRollingDiceIdList,
  isChainCard, isChainCounter, isChainScoreList, isTurnCardList, isTurnEnd,
  TOTAL_DICE,
} from '../src/utils/turnShapes';
import {
  isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry,
  isValidEnforcedDiceMode, isValidRuleset,
  MAX_CARD_COUNT, VALID_CARD_TYPES,
  MAX_TURN_DURATION, MAX_RECONNECT_TIMEOUT,
} from '../src/utils/configValidation';
import { PLAYER_STAT_FIELDS } from '../src/utils/playerStats';
import type { RoomState, ServerPlayer } from './roomTypes';

// A fully-loaded deck has at most MAX_CARD_COUNT of each of the 11 card types.
const MAX_DECK_SIZE = MAX_CARD_COUNT * 11;
// Exported for turnTimers.ts: the timeout path appends its own round-end
// datapoints and must respect the same bound the pushed arrays get.
// Generous safety cap for per-round arrays (chartLabels/chartValues entries) — far
// beyond any real game, just enough to stop a malicious pushState from growing
// these arrays without bound.
export const MAX_ROUNDS = 100000;
const MAX_SCORE_MAGNITUDE = 1_000_000;
const MAX_GAME_SECONDS = 10_000_000;

// The chain's Plus/Minus running totals: shape from turnShapes, magnitude the
// network's own rule — the engine adds each one to a player's score, so an
// unbounded entry off the wire is an unbounded score.
const isPlusMinusScoreList = (v: unknown): v is number[] =>
  isChainScoreList(v) && v.every(n => n <= MAX_SCORE_MAGNITUDE);

// What each Plus/Minus deduction actually removed, one entry per name in
// deductedPlayers. Bounded like every other pushed score, and never negative —
// the classic 0-floor can shrink a hit, never invert it. The lengths must
// match because the activity log reads the two lists BY INDEX
// (summarizeDeductions): a longer or shorter list would print one player's
// clamped amount against another's name, so a misaligned pair is rejected
// rather than half-kept. Missing names with amounts present is the same fault.
const isDeductedAmountList = (amounts: unknown, names: unknown): boolean => {
  if (!Array.isArray(amounts)) return false;
  if (amounts.length !== (Array.isArray(names) ? names.length : 0)) return false;
  return amounts.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SCORE_MAGNITUDE);
};

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
  if (!(typeof s.turnScore === 'number' && Number.isFinite(s.turnScore))) return false;
  if (!(typeof s.tuttosThisTurn === 'number' && Number.isFinite(s.tuttosThisTurn))) return false;
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
  if (s.deductedAmounts !== undefined && !isDeductedAmountList(s.deductedAmounts, s.deductedPlayers)) return false;
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

  if (!(typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 100)) return false;
  if (!(typeof entry.round === 'number' && Number.isInteger(entry.round) && entry.round >= 1 && entry.round <= MAX_ROUNDS)) return false;
  if (!(typeof entry.playerName === 'string' && entry.playerName.length > 0 && entry.playerName.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  if (entry.playerColor !== undefined && !(typeof entry.playerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.playerColor))) return false;
  if (!(typeof entry.card === 'string' && (VALID_CARD_TYPES as readonly string[]).includes(entry.card))) return false;
  if (!(typeof entry.type === 'string' && validTypes.includes(entry.type))) return false;
  if (!(typeof entry.score === 'number' && Number.isFinite(entry.score) && Math.abs(entry.score) <= MAX_SCORE_MAGNITUDE)) return false;
  if (entry.deductedPlayers !== undefined) {
    if (!Array.isArray(entry.deductedPlayers)) return false;
    if (entry.deductedPlayers.length > 100) return false;
    if (!entry.deductedPlayers.every(name => typeof name === 'string' && name.length > 0 && name.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  }
  // Same index-alignment rule as the turn summary's — this is the entry the
  // activity log actually renders, so a misaligned pair would be printed.
  if (entry.deductedAmounts !== undefined && !isDeductedAmountList(entry.deductedAmounts, entry.deductedPlayers)) return false;
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
// silently expanding/shrinking what a push is allowed to touch.
const HOST_ONLY_FIELDS: ReadonlySet<string> = Object.freeze(new Set<string>([
  'status', 'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout', 'enforcedDiceMode', 'ruleset',
]));

const ACTIVE_PLAYER_FIELDS: ReadonlySet<string> = Object.freeze(new Set<string>([
  'currentCard', 'cards', 'currentPlayerIndex', 'round',
  'finished', 'previousCard', 'previousScore', 'previousLeaders',
  'previousWasBust', 'previousWasSuccess',
  'previousHighestTurnScore', 'previousHighestFeuerwerkTurnScore',
  'previousHighestX2TurnScore', 'previousPlayerName', 'previousTurnSummary',
  'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
  'players', 'liveTurnState', 'historyLog',
]));

// Same length cap joinRoom enforces on a player's name.
const MAX_PLAYER_NAME_LENGTH = 30;

const ALL_FIELDS: ReadonlySet<string> = Object.freeze(new Set<string>([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]));

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
const PUSHED_NUMERIC_FIELD_BOUNDS: Record<string, { min: number; max: number }> = {
  turnDuration: { min: 0, max: MAX_TURN_DURATION },
  reconnectTimeout: { min: 0, max: MAX_RECONNECT_TIMEOUT },
};

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

const mergeMutable = (existing: ServerPlayer, p: Record<string, unknown> | undefined): ServerPlayer => {
  if (!p) return existing;
  const updated = { ...existing };
  for (const f of PLAYER_MUTABLE) {
    if (!(f in p)) continue;
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
  // allowRulesetWrite is computed by the caller from the PRE-push status
  // (lobby, or the push that starts the game) — it must not be derived from
  // state.status inside the field loop below, because 'status' is the first
  // Set entry and has already been overwritten by the time later keys apply.
  { isHost, startingGame, allowRulesetWrite = false }: { isHost: boolean; startingGame: boolean; allowRulesetWrite?: boolean },
): boolean => {
  const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

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

  for (const key of allowedFields) {
    if (!(key in newState)) continue;
    if (key === 'players') {
      const pushed = newState.players as Record<string, unknown>[];

      const pushedNames = pushed.map(p => p.name as string);
      const isStrictPermutation = new Set(pushedNames).size === state.players.length;

      if (startingGame && isStrictPermutation) {
        // Adopt the host's chosen ordering, but keep the server-side player
        // identities and non-mutable fields. Keeps chartNames/chartValues
        // (pushed in the same order) aligned with the authoritative roster.
        const byName = new Map(state.players.map(p => [p.name, p]));
        state.players = pushedNames.map(name =>
          mergeMutable(byName.get(name)!, pushed.find(q => q.name === name)),
        );
      } else {
        state.players = state.players.map(existing =>
          mergeMutable(existing, pushed.find(q => q.name === existing.name)),
        );
      }
    } else if (key === 'winningScore') {
      if (isValidWinningScore(newState.winningScore)) state.winningScore = newState.winningScore;
    } else if (key in PUSHED_NUMERIC_FIELD_BOUNDS) {
      const v = newState[key];
      const { min, max } = PUSHED_NUMERIC_FIELD_BOUNDS[key];
      // Integers only: the loose >= 0 floor stays (integration tests push 1-2s
      // turns), but a SUB-SECOND duration would arm the 10ms-floor server
      // timer as a self-advancing loop that never ends the game.
      if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) {
        (state as unknown as Record<string, unknown>)[key] = v;
      }
    } else if (key === 'initialCards') {
      if (validateInitialCards(newState.initialCards)) state.initialCards = newState.initialCards;
    } else if (key === 'status') {
      if (newState.status === 'lobby' || newState.status === 'playing') state.status = newState.status;
    } else if (key === 'randomOrder') {
      if (typeof newState.randomOrder === 'boolean') state.randomOrder = newState.randomOrder;
    } else if (key === 'currentCard' || key === 'previousCard') {
      const v = newState[key];
      if (v === null || VALID_CARD_TYPES.includes(v as CardType)) {
        (state as unknown as Record<string, unknown>)[key] = v;
      }
    } else if (key === 'cards') {
      const v = newState.cards;
      if (Array.isArray(v) && v.length <= MAX_DECK_SIZE && v.every(c => VALID_CARD_TYPES.includes(c as CardType))) {
        state.cards = v as CardType[];
      }
    } else if (key === 'currentPlayerIndex') {
      const v = newState.currentPlayerIndex;
      if (v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < state.players.length)) {
        state.currentPlayerIndex = v as number | null;
      }
    } else if (key === 'round') {
      const v = newState.round;
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ROUNDS) {
        state.round = v;
      }
    } else if (key === 'finished') {
      if (typeof newState.finished === 'boolean') state.finished = newState.finished;
    } else if (key === 'previousScore') {
      const v = newState.previousScore;
      if (v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCORE_MAGNITUDE)) {
        state.previousScore = v as number | null;
      }
    } else if (key === 'previousLeaders') {
      const v = newState.previousLeaders;
      if (v === null) {
        state.previousLeaders = null;
      } else if (Array.isArray(v) && v.length <= state.players.length && v.every(isPlausiblePlayerSnapshot)) {
        // Rebuilt from only the checked fields — isPlausiblePlayerSnapshot only
        // shape-checks name/score, so storing `v` as-is would let extra
        // properties on each entry ride along into every future broadcast.
        state.previousLeaders = v.map(p => ({ name: p.name, score: p.score })) as ServerPlayer[];
      }
    } else if (key === 'previousWasBust') {
      if (typeof newState.previousWasBust === 'boolean') state.previousWasBust = newState.previousWasBust;
    } else if (key === 'previousWasSuccess') {
      // A client predating this field omits the key entirely, so the loop
      // above skips it and the room keeps what it had — which is exactly the
      // "no outcome recorded" state undo's fallback expects.
      if (typeof newState.previousWasSuccess === 'boolean') state.previousWasSuccess = newState.previousWasSuccess;
    } else if (key === 'previousHighestTurnScore') {
      const v = newState.previousHighestTurnScore;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE) {
        state.previousHighestTurnScore = v;
      }
    } else if (key === 'previousHighestFeuerwerkTurnScore') {
      const v = newState.previousHighestFeuerwerkTurnScore;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE) {
        state.previousHighestFeuerwerkTurnScore = v;
      }
    } else if (key === 'previousHighestX2TurnScore') {
      const v = newState.previousHighestX2TurnScore;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE) {
        state.previousHighestX2TurnScore = v;
      }
    } else if (key === 'previousPlayerName') {
      const v = newState.previousPlayerName;
      if (v === null || (typeof v === 'string' && v.length > 0 && v.length <= MAX_PLAYER_NAME_LENGTH)) {
        state.previousPlayerName = v as string | null;
      }
    } else if (key === 'previousTurnSummary') {
      const v = newState.previousTurnSummary;
      if (v === null) {
        state.previousTurnSummary = null;
      } else if (isValidTurnSummary(v)) {
        state.previousTurnSummary = sanitizeTurnSummary(v);
      }
    } else if (key === 'chartValues') {
      const v = newState.chartValues;
      if (
        Array.isArray(v) && v.length === state.players.length &&
        v.every(arr => Array.isArray(arr) && arr.length <= MAX_ROUNDS && arr.every(n => typeof n === 'number' && Number.isFinite(n)))
      ) {
        state.chartValues = v as number[][];
      }
    } else if (key === 'chartNames') {
      const v = newState.chartNames;
      // Entries are player names, so they follow the same 1-30 char rule as
      // previousPlayerName/historyLog.playerName. Without the length cap this
      // was the one client-pushed string stored unbounded — and rebroadcast
      // to every client on each subsequent emitRoomState.
      if (
        Array.isArray(v) && v.length === state.players.length &&
        v.every(n => typeof n === 'string' && n.length > 0 && n.length <= MAX_PLAYER_NAME_LENGTH)
      ) {
        state.chartNames = v as string[];
      }
    } else if (key === 'chartLabels') {
      const v = newState.chartLabels;
      if (Array.isArray(v) && v.length <= MAX_ROUNDS && v.every(n => typeof n === 'number' && Number.isFinite(n))) {
        state.chartLabels = v as number[];
      }
    } else if (key === 'gameTimeInSeconds') {
      const v = newState.gameTimeInSeconds;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_GAME_SECONDS) {
        state.gameTimeInSeconds = v;
      }
    } else if (key === 'liveTurnState') {
      const v = newState.liveTurnState;
      if (v === null) {
        state.liveTurnState = null;
      } else if (isValidDiceSnapshot(v)) {
        state.liveTurnState = sanitizeDiceSnapshot(v);
      }
    } else if (key === 'enforcedDiceMode') {
      const v = newState.enforcedDiceMode;
      if (isValidEnforcedDiceMode(v)) state.enforcedDiceMode = v;
    } else if (key === 'ruleset') {
      // Unlike the other host-only config fields, a mid-game write is refused
      // outright: flipping the rule set under an active game would change the
      // turn logic on every client mid-turn. The normalizedGame-style sticky
      // downgrade can't help here — it only protects the stats label, not
      // gameplay. Lobby pushes and the game-starting push itself still pass.
      if (allowRulesetWrite && isValidRuleset(newState.ruleset)) state.ruleset = newState.ruleset;
    } else if (key === 'historyLog') {
      const v = newState.historyLog;
      if (Array.isArray(v) && v.length <= MAX_HISTORY_LOG_SIZE && v.every(isValidHistoryEntry)) {
        state.historyLog = v.map(sanitizeHistoryEntry);
      }
    }
  }

  return true;
};
