import type { CardType, InitialCards, DiceSnapshot } from '../src/types';
import {
  isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry,
  MAX_CARD_COUNT, VALID_CARD_TYPES,
} from '../src/utils/configValidation';
import type { RoomState, ServerPlayer } from './roomTypes';

// A fully-loaded deck has at most MAX_CARD_COUNT of each of the 11 card types.
const MAX_DECK_SIZE = MAX_CARD_COUNT * 11;
// Generous safety cap for per-round arrays (chartLabels/chartValues entries) — far
// beyond any real game, just enough to stop a malicious pushState from growing
// these arrays without bound.
const MAX_ROUNDS = 100000;
const MAX_SCORE_MAGNITUDE = 1_000_000;
const MAX_GAME_SECONDS = 10_000_000;

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
  const { winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout } = config;
  if (isValidWinningScore(winningScore)) state.winningScore = winningScore;
  if (validateInitialCards(initialCards)) state.initialCards = initialCards;
  if (typeof randomOrder === 'boolean') state.randomOrder = randomOrder;
  if (isValidTurnDuration(turnDuration)) state.turnDuration = turnDuration;
  if (isValidReconnectTimeout(reconnectTimeout)) state.reconnectTimeout = reconnectTimeout;
};

// Minimal shape check for a previousLeaders snapshot entry — just enough for
// calculateUndo (client-side) to read name/score back out safely.
export const isPlausiblePlayerSnapshot = (v: unknown): v is { name: string; score: number } => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.name === 'string' && typeof p.score === 'number' && Number.isFinite(p.score);
};

export const isValidDiceSnapshot = (v: unknown): v is DiceSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.turnScore === 'number' && Number.isFinite(s.turnScore)
    && typeof s.tuttosThisTurn === 'number' && Number.isFinite(s.tuttosThisTurn)
    && Array.isArray(s.keptDice) && s.keptDice.length <= 6
    && Array.isArray(s.currentRoll) && s.currentRoll.length <= 6
    && Array.isArray(s.kniffelProgress) && s.kniffelProgress.length <= 6;
};

const HOST_ONLY_FIELDS = new Set<string>([
  'status', 'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout',
]);

const ACTIVE_PLAYER_FIELDS = new Set<string>([
  'currentCard', 'cards', 'currentPlayerIndex', 'round',
  'finished', 'previousCard', 'previousScore', 'previousLeaders',
  'previousWasBust', 'previousHighestTurnScore',
  'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
  'players', 'liveTurnState',
]);

const ALL_FIELDS = new Set<string>([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]);

// Upper bounds for numeric config fields arriving via pushState. Unlike
// applyValidatedConfig this is a sanity guard, not a UX rule (pushState mirrors
// state the client already ran through updateConfig, and tests legitimately
// push short 1-2s turns): it only rejects values that would corrupt server-side
// logic — a negative/non-finite turnDuration makes startServerTurnTimer re-arm
// with remaining<=0 and advance turns in a synchronous loop until the stack
// overflows, and an unvalidated initialCards object can send buildDeck into an
// unbounded loop on the next deck rebuild.
const PUSHED_NUMERIC_FIELD_MAX: Record<string, number> = {
  winningScore: 99999,
  turnDuration: 600,
  reconnectTimeout: 3600,
};

const PLAYER_MUTABLE: (keyof ServerPlayer)[] = [
  'score', 'times1000PointsDeducted', 'timesKniffelCompleted',
  'timesPlusMinusCompleted', 'timesKniffelFailed', 'timesKleeblattFailed',
  'timesKleeblattCompleted', 'timesPlusMinusFailed', 'timesFeuerwerkReceived',
  'timesSkipped', 'timesx2Received', 'totalTurns', 'busts',
  'feuerwerkBusts', 'x2Busts', 'feuerwerkPointsScored', 'x2PointsScored',
  'highestTurnScore', 'position', 'color', 'disconnected',
];

// Matched by name, not deviceId: name is already unique within a room (enforced
// at join) and, unlike deviceId, was never meant to be secret — reorderPlayers
// already keys off it the same way. Keeping deviceId out of this match means it
// never has to round-trip through a broadcast (see sanitizePlayerForBroadcast).
export const validatePushedPlayers = (existing: ServerPlayer[], pushed: unknown[]): boolean => {
  if (!Array.isArray(pushed) || pushed.length !== existing.length) return false;
  const existingNames = new Set(existing.map(p => p.name));
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
    } else if (f === 'disconnected') {
      if (typeof v === 'boolean') updated.disconnected = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
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
export const applyPushedState = (
  state: RoomState,
  newState: Record<string, unknown>,
  { isHost, startingGame }: { isHost: boolean; startingGame: boolean },
): void => {
  const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

  for (const key of allowedFields) {
    if (!(key in newState)) continue;
    if (key === 'players') {
      const pushed = newState.players as Record<string, unknown>[];
      if (!validatePushedPlayers(state.players, pushed)) continue;

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
    } else if (key in PUSHED_NUMERIC_FIELD_MAX) {
      const v = newState[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PUSHED_NUMERIC_FIELD_MAX[key]) {
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
        state.previousLeaders = v as ServerPlayer[];
      }
    } else if (key === 'previousWasBust') {
      if (typeof newState.previousWasBust === 'boolean') state.previousWasBust = newState.previousWasBust;
    } else if (key === 'previousHighestTurnScore') {
      const v = newState.previousHighestTurnScore;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE) {
        state.previousHighestTurnScore = v;
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
      if (Array.isArray(v) && v.length === state.players.length && v.every(n => typeof n === 'string')) {
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
      if (v === null || isValidDiceSnapshot(v)) {
        state.liveTurnState = v as DiceSnapshot | null;
      }
    }
  }
};
