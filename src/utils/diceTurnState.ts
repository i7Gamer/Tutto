import type { CardType, Die, DiceSnapshot, SnapshotDie } from '../types';

// Identifies a specific turn slot: roomId (or 'local') + round + player index +
// card. Changes whenever the turn actually advances, whether via the active
// client, the server-authoritative turn timer, or a reconnect — so a snapshot
// saved for an earlier turn is distinguishable from the current one even when
// it belongs to the same player (e.g. their turn comes around again next round).
export const buildTurnKey = (
  roomId: string | null,
  round: number,
  currentPlayerIndex: number | null,
  currentCard: CardType | null,
): string => `${roomId ?? 'local'}:${round}:${currentPlayerIndex}:${currentCard ?? 'none'}`;

interface BuildDiceSnapshotInput {
  turnScore: number;
  keptDice: Die[];
  currentRoll: Die[];
  kniffelProgress: number[];
  tuttosThisTurn: number;
  rollingDiceIndices?: Set<string> | string[];
  busted?: boolean;
}

// Shape checks below mirror server/pushValidation.ts's isValidDiceSnapshot
// family (id string, val 1-6, kniffelProgress entries 1-6) — this is the
// same DiceSnapshot shape, just restored from localStorage instead of a
// socket push. A malformed entry here can't reach another player (only this
// device's own DiceGame reads its own cache), but it's still rendered
// directly (Die/DiePips) and consumed by array methods (.filter/.map/.sort)
// throughout DiceGame — a non-array or garbage entry would otherwise crash
// the render on mount rather than just resuming from a clean slate.
const isPlausibleSnapshotDie = (v: unknown): v is SnapshotDie => {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && d.id.length > 0 &&
    Number.isInteger(d.val) && (d.val as number) >= 1 && (d.val as number) <= 6;
};

const isPlausibleRolledDie = (v: unknown): v is SnapshotDie & { selected: boolean } =>
  isPlausibleSnapshotDie(v) && typeof (v as unknown as Record<string, unknown>).selected === 'boolean';

const isPlausibleKniffelEntry = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 6;

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
    return {
      turnScore: isFiniteNonNegativeNumber(parsed.turnScore) ? parsed.turnScore : 0,
      keptDice: asValidatedArray(parsed.keptDice, isPlausibleSnapshotDie),
      currentRoll: asValidatedArray(parsed.currentRoll, isPlausibleRolledDie),
      kniffelProgress: asValidatedArray(parsed.kniffelProgress, isPlausibleKniffelEntry),
      tuttosThisTurn: isFiniteNonNegativeNumber(parsed.tuttosThisTurn) ? parsed.tuttosThisTurn : 0,
      busted: !!parsed.busted,
      playerName: typeof parsed.playerName === 'string' ? parsed.playerName : undefined,
      turnKey: typeof parsed.turnKey === 'string' ? parsed.turnKey : undefined,
    };
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
}: BuildDiceSnapshotInput): DiceSnapshot => {
  const snapshot: DiceSnapshot = {
    turnScore,
    keptDice: keptDice.map(d => ({ id: d.id, val: d.val })),
    currentRoll: currentRoll.map(d => ({ id: d.id, val: d.val, selected: busted ? false : (d.selected ?? false) })),
    kniffelProgress,
    tuttosThisTurn,
  };
  if (busted) {
    snapshot.busted = true;
  } else {
    snapshot.rollingDiceIds = Array.from(rollingDiceIndices ?? []);
  }
  return snapshot;
};
