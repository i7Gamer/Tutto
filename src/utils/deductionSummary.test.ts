/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { summarizeDeductions } from './deductionSummary';

describe('summarizeDeductions', () => {
  it('returns nothing for a turn that deducted nobody', () => {
    expect(summarizeDeductions([])).toEqual([]);
  });

  it('reports a single deduction as one entry of 1000', () => {
    expect(summarizeDeductions(['Bob'])).toEqual([{ name: 'Bob', amount: 1000 }]);
  });

  it('keeps distinct leaders apart', () => {
    expect(summarizeDeductions(['Bob', 'Carol'])).toEqual([
      { name: 'Bob', amount: 1000 },
      { name: 'Carol', amount: 1000 },
    ]);
  });

  it('totals a player docked twice in one chain instead of naming them twice', () => {
    // The reason this exists: the log used to join the raw list, so a chain
    // with two Plus/Minus cards that both hit Bob read "Bob, Bob lost 1000".
    expect(summarizeDeductions(['Bob', 'Bob'])).toEqual([{ name: 'Bob', amount: 2000 }]);
  });

  it('totals per player when a chain moves between leaders and back', () => {
    // Deductions recompute the leader between cards, so the same player can be
    // hit non-consecutively.
    expect(summarizeDeductions(['Bob', 'Carol', 'Bob'])).toEqual([
      { name: 'Bob', amount: 2000 },
      { name: 'Carol', amount: 1000 },
    ]);
  });

  it('orders players by their first deduction, not alphabetically', () => {
    expect(summarizeDeductions(['Zoe', 'Adam']).map(d => d.name)).toEqual(['Zoe', 'Adam']);
  });
});
