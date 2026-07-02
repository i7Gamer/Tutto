import type { CardType, Die, DiceSnapshot } from '../types';

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
      playerName: parsed.playerName,
      turnKey: parsed.turnKey,
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
