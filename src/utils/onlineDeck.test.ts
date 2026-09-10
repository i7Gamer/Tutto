import { describe, expect, it } from 'vitest';
import { deckComposition, compositionCards, compositionSize } from './onlineDeck';

describe('public deck composition', () => {
  it('has identical serialized output for different private permutations', () => {
    expect(JSON.stringify(deckComposition(['Stop', '200', 'Stop', 'x2'])))
      .toBe(JSON.stringify(deckComposition(['x2', 'Stop', '200', 'Stop'])));
    expect(deckComposition(['Stop', '200', 'Stop'])).toEqual({ Stop: 2, '200': 1 });
  });

  it('expands composition only as a canonical display/probability bag', () => {
    expect(compositionCards({ Stop: 2, '200': 1 })).toEqual(['Stop', 'Stop', '200']);
    expect(compositionSize({ Stop: 2, '200': 1 })).toBe(3);
  });

  it('represents an exhausted or absent public deck without inventing a draw', () => {
    expect(deckComposition([])).toEqual({});
    expect(compositionCards(null)).toEqual([]);
    expect(compositionSize(null)).toBe(0);
    expect(compositionCards({ Stop: 0 })).toEqual([]);
  });
});
