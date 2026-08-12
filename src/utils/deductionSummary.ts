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
 *
 * deductedAmounts is the parallel list of what each of those hits ACTUALLY
 * removed — the classic 0-floor can make that less than PLUS_MINUS_SCORE, and
 * re-deriving the amount here reported a leader on 400 as having lost 1000
 * while his score visibly dropped by 400. It is optional because a modernized
 * turn never clamps (so every hit is the full amount) and because an entry
 * relayed by a server that does not carry the field yet arrives without it;
 * the fallback is per index, not per list, so a truncated list still reports
 * the amounts it does carry.
 */
export const summarizeDeductions = (
  deductedPlayers: readonly string[],
  deductedAmounts?: readonly number[],
): DeductionTotal[] => {
  const totals = new Map<string, number>();
  deductedPlayers.forEach((name, i) => {
    totals.set(name, (totals.get(name) ?? 0) + (deductedAmounts?.[i] ?? PLUS_MINUS_SCORE));
  });
  return [...totals].map(([name, amount]) => ({ name, amount }));
};
