import type { Die, DiceSnapshot } from '../types';

interface BuildDiceSnapshotInput {
  turnScore: number;
  keptDice: Die[];
  currentRoll: Die[];
  kniffelProgress: number[];
  tuttosThisTurn: number;
  rollingDiceIndices?: Set<string> | string[];
  busted?: boolean;
}

export const parseSavedDiceState = (raw: string | null): DiceSnapshot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DiceSnapshot>;
    return {
      turnScore: parsed.turnScore ?? 0,
      keptDice: parsed.keptDice ?? [],
      currentRoll: parsed.currentRoll ?? [],
      kniffelProgress: parsed.kniffelProgress ?? [],
      tuttosThisTurn: parsed.tuttosThisTurn ?? 0,
      busted: !!parsed.busted,
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
