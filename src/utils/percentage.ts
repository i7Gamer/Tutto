/**
 * A whole-number percentage, or null when there is nothing to divide by.
 *
 * Every rate on the statistics screen was computing this inline, each with its
 * own guard and its own answer for the empty case — some showing 0%, one
 * showing a dash. The division is the shared part; what to show when a player
 * has not played yet is a decision for the screen, so it stays with the
 * caller.
 */
export const percentageOf = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;
