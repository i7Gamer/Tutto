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

  it('reports what the 0-floor actually removed, not the full 1000', () => {
    // Classic: a leader on 400 loses 400, not 1000 — the log used to re-derive
    // the amount from PLUS_MINUS_SCORE and printed a drop nobody could see.
    expect(summarizeDeductions(['Bob'], [400])).toEqual([{ name: 'Bob', amount: 400 }]);
  });

  it('totals the real amounts when the same player is docked twice', () => {
    expect(summarizeDeductions(['Bob', 'Bob'], [1000, 200])).toEqual([{ name: 'Bob', amount: 1200 }]);
  });

  it('keeps per-player totals apart when the amounts differ', () => {
    expect(summarizeDeductions(['Bob', 'Carol', 'Bob'], [1000, 250, 700])).toEqual([
      { name: 'Bob', amount: 1700 },
      { name: 'Carol', amount: 250 },
    ]);
  });

  it('falls back to the full 1000 for entries with no recorded amount', () => {
    // Modernized turns record no amounts (they never clamp), and a classic
    // entry relayed by a server that does not carry the field yet arrives with
    // it stripped — both must still read as the flat deduction they were.
    expect(summarizeDeductions(['Bob', 'Carol'], undefined)).toEqual([
      { name: 'Bob', amount: 1000 },
      { name: 'Carol', amount: 1000 },
    ]);
    // A short/truncated list falls back per missing index rather than per list.
    expect(summarizeDeductions(['Bob', 'Carol'], [400])).toEqual([
      { name: 'Bob', amount: 400 },
      { name: 'Carol', amount: 1000 },
    ]);
  });
});
