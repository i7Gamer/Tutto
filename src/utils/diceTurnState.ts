import { localStore } from './storage';
import type { CardType, Die, DiceSnapshot, Ruleset } from '../types';
import { MAX_CHAIN_CARDS } from '../types';
import { DEFAULT_RULESET } from './configValidation';
import {
  isSnapshotDie, isRolledDie, isKniffelProgressEntry, isChainCard, isChainCounter,
} from './turnShapes';

/**
 * Where a turn in progress is cached, so a reload or reconnect can resume into
 * it instead of losing the dice already on the table.
 *
 * Named because nineteen call sites across the components and the store read,
 * write and clear this one entry, and a typo in any of them fails silently:
 * the write goes to a key nobody reads, or the clear leaves the real entry
 * behind to be restored into somebody's next turn.
 */
export const DICE_TURN_STATE_KEY = 'tutto_dice_turn_state';

// Its physical-dice counterpart — the classic chain, the open bank-or-draw
// choice and the typed running total (owned by hooks/usePhysicalChain.ts,
// which documents the shape). Defined here so the lifecycle helper below and
// the store slices need not import from a React hook module.
export const PHYSICAL_TURN_STATE_KEY = 'tutto_physical_turn_state';

// Every game-lifecycle boundary that invalidates a cached turn invalidates
// BOTH caches — a new game, a committed/undone turn, leaving or joining a
// room, a crash reset. One helper, so a cache can never miss a site: the
// turn keys alone cannot be trusted across games (Play Again resets round to
// 1 with the same room and ruleset, so a stale entry can key-collide with
// the new game's first turn).
export const clearTurnCaches = (): void => {
  localStore.remove(DICE_TURN_STATE_KEY);
  localStore.remove(PHYSICAL_TURN_STATE_KEY);
};

// Identifies a specific turn slot: roomId (or 'local') + round + player index +
// card + ruleset. Changes whenever the turn actually advances, whether via the
// active client, the server-authoritative turn timer, or a reconnect — so a
// snapshot saved for an earlier turn is distinguishable from the current one
// even when it belongs to the same player (e.g. their turn comes around again
// next round). Mid-chain the card component is the LATEST drawn card — both
// the stamping site (gameSlice.setLiveTurnState) and the restore comparison
// (Game.tsx) read store currentCard, so the two always agree; the ruleset
// component keeps a classic snapshot from restoring into a modernized game.
export const buildTurnKey = (
  roomId: string | null,
  round: number,
  currentPlayerIndex: number | null,
  currentCard: CardType | null,
  ruleset: Ruleset = DEFAULT_RULESET,
): string => `${roomId ?? 'local'}:${round}:${currentPlayerIndex}:${currentCard ?? 'none'}:${ruleset}`;

interface BuildDiceSnapshotInput {
  turnScore: number;
  keptDice: Die[];
  currentRoll: Die[];
  kniffelProgress: number[];
  tuttosThisTurn: number;
  rollingDiceIndices?: Set<string> | string[];
  busted?: boolean;
  // The turn was decided by Stop & Score — see DiceSnapshot in types.ts.
  stopped?: boolean;
  // Classic-chain fields — see DiceSnapshot in types.ts.
  cardsThisTurn?: CardType[];
  plusMinusSuccesses?: number;
  chainTuttoCount?: number;
}

// The shape checks come from utils/turnShapes.ts, shared with
// server/pushValidation.ts's isValidDiceSnapshot family — this is the same
// DiceSnapshot shape, just restored from localStorage instead of a socket
// push. A malformed entry here can't reach another player (only this device's
// own DiceGame reads its own cache), but it's still rendered directly
// (Die/DiePips) and consumed by array methods (.filter/.map/.sort) throughout
// DiceGame — a non-array or garbage entry would otherwise crash the render on
// mount rather than just resuming from a clean slate.

// Whole-array rejection (not per-entry filtering) on any invalid entry —
// same all-or-nothing rule persistence.ts's pickLocalGameState applies to
// its own restored arrays, so a snapshot that fails validation resets to the
// same empty default a missing field already gets, rather than silently
// keeping a partial/reordered subset of it.
const asValidatedArray = <T,>(v: unknown, isValidEntry: (x: unknown) => x is T): T[] =>
  Array.isArray(v) && v.every(isValidEntry) ? v : [];

const isFiniteNonNegativeNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

export const parseSavedDiceState = (raw: string | null): DiceSnapshot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DiceSnapshot>;
    const snapshot: DiceSnapshot = {
      turnScore: isFiniteNonNegativeNumber(parsed.turnScore) ? parsed.turnScore : 0,
      keptDice: asValidatedArray(parsed.keptDice, isSnapshotDie),
      currentRoll: asValidatedArray(parsed.currentRoll, isRolledDie),
      kniffelProgress: asValidatedArray(parsed.kniffelProgress, isKniffelProgressEntry),
      tuttosThisTurn: isFiniteNonNegativeNumber(parsed.tuttosThisTurn) ? parsed.tuttosThisTurn : 0,
      busted: !!parsed.busted,
      playerName: typeof parsed.playerName === 'string' ? parsed.playerName : undefined,
      turnKey: typeof parsed.turnKey === 'string' ? parsed.turnKey : undefined,
    };
    if (parsed.stopped === true) snapshot.stopped = true;
    // Chain fields are optional (absent for modernized turns and old caches);
    // present-but-invalid values reset to absent, same all-or-nothing rule as
    // the arrays above.
    if (Array.isArray(parsed.cardsThisTurn) && parsed.cardsThisTurn.length <= MAX_CHAIN_CARDS &&
        parsed.cardsThisTurn.every(isChainCard)) {
      snapshot.cardsThisTurn = parsed.cardsThisTurn;
    }
    if (isChainCounter(parsed.plusMinusSuccesses)) snapshot.plusMinusSuccesses = parsed.plusMinusSuccesses;
    if (isChainCounter(parsed.chainTuttoCount)) snapshot.chainTuttoCount = parsed.chainTuttoCount;
    return snapshot;
  } catch {
    return null;
  }
};

export const buildDiceSnapshot = ({
  turnScore,
  keptDice,
  currentRoll,
  kniffelProgress,
  tuttosThisTurn,
  rollingDiceIndices,
  busted = false,
  stopped = false,
  cardsThisTurn,
  plusMinusSuccesses,
  chainTuttoCount,
}: BuildDiceSnapshotInput): DiceSnapshot => {
  const snapshot: DiceSnapshot = {
    turnScore,
    keptDice: keptDice.map(d => ({ id: d.id, val: d.val })),
    currentRoll: currentRoll.map(d => ({ id: d.id, val: d.val, selected: busted ? false : (d.selected ?? false) })),
    kniffelProgress,
    tuttosThisTurn,
  };
  if (stopped) snapshot.stopped = true;
  if (busted) {
    snapshot.busted = true;
  } else {
    snapshot.rollingDiceIds = Array.from(rollingDiceIndices ?? []);
  }
  if (cardsThisTurn) snapshot.cardsThisTurn = [...cardsThisTurn];
  if (plusMinusSuccesses !== undefined) snapshot.plusMinusSuccesses = plusMinusSuccesses;
  if (chainTuttoCount !== undefined) snapshot.chainTuttoCount = chainTuttoCount;
  return snapshot;
};
