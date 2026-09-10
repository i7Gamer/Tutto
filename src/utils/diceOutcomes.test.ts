import { describe, expect, it } from 'vitest';
import { buildDiceSnapshot, parseSavedDiceState } from './diceTurnState';
import { deriveRestoredTurn } from './diceTurnRestore';

describe('digital outcome journal persistence', () => {
  it('round-trips bounded card outcomes through a snapshot and restore', () => {
    const cardOutcomes = [{ card: 'Feuerwerk' as const, scoreBefore: 0, scoreAfter: 1200, tuttos: 2 }];
    const snapshot = buildDiceSnapshot({ turnScore: 1200, keptDice: [], currentRoll: [], kniffelProgress: [],
      tuttosThisTurn: 2, chainTuttoCount: 2, cardsThisTurn: ['Feuerwerk'], cardOutcomes });
    const restored = parseSavedDiceState(JSON.stringify(snapshot));
    expect(restored?.cardOutcomes).toEqual(cardOutcomes);
    expect(deriveRestoredTurn({ restored, currentCard: 'Feuerwerk', ruleset: 'classic' }).initialChain.outcomes).toEqual(cardOutcomes);
    expect(snapshot.cardOutcomes?.[0]).not.toBe(cardOutcomes[0]);
  });

  it('does not resume malformed journal values', () => {
    expect(parseSavedDiceState(JSON.stringify({ cardOutcomes: [{ card: 'Stop', tuttos: Infinity }] }))?.cardOutcomes).toBeUndefined();
  });
});
