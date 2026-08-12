import { PLUS_MINUS_SCORE } from './coreGameEngine';

export interface DeductionTotal {
  name: string;
  amount: number;
}

/**
 * A turn's Plus/Minus deductions, totalled per PLAYER rather than per hit.
 *
 * historyEntry.deductedPlayers carries one entry per deduction occurrence,
 * because that is what undo has to reverse (see calculateUndo). A classic
 * chain can dock the same player on more than one of its Plus/Minus cards, so
 * rendering that list raw would print their name twice instead of doubling the
 * amount. Insertion order is kept, so the list reads in the order the chain
 * imposed the deductions.
 */
export const summarizeDeductions = (deductedPlayers: readonly string[]): DeductionTotal[] => {
  const totals = new Map<string, number>();
  for (const name of deductedPlayers) {
    totals.set(name, (totals.get(name) ?? 0) + PLUS_MINUS_SCORE);
  }
  return [...totals].map(([name, amount]) => ({ name, amount }));
};
