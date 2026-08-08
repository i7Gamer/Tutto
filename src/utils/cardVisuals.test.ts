/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { CARD_EMOJIS, UNKNOWN_CARD_EMOJI } from './cardVisuals';
import { VALID_CARD_TYPES } from './configValidation';

describe('cardVisuals', () => {
  describe('CARD_EMOJIS', () => {
    it('gives every card type an icon', () => {
      // The history log and the statistics card breakdown both read from
      // here, so a card added without an icon would show up bare in one
      // place and as the unknown-card fallback in the other.
      for (const card of VALID_CARD_TYPES) {
        expect(CARD_EMOJIS[card]).toBeTruthy();
      }
    });

    it('describes no card the game cannot deal', () => {
      for (const card of Object.keys(CARD_EMOJIS)) {
        expect(VALID_CARD_TYPES).toContain(card);
      }
    });
  });

  describe('UNKNOWN_CARD_EMOJI', () => {
    it('stands in for a card this build does not know', () => {
      // History entries arrive from the server and from localStorage, so the
      // card name in one is not guaranteed to be a card this build deals.
      expect(UNKNOWN_CARD_EMOJI).toBeTruthy();
    });
  });
});
