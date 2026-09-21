/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { createRoom } from './rooms';
import { applyValidatedConfig, validateInitialCards } from './roomConfigValidation';

const CUSTOM_WINNING_SCORE = 7777;
const INVALID_TURN_DURATION = 5;
const CUSTOM_RECONNECT_TIMEOUT = 0;
const CUSTOM_CARD_COUNT = 2;
const OVER_CARD_COUNT = 100;

const makeState = () => createRoom('sock-Alice').state;

describe('validateInitialCards', () => {
  it('accepts only a playable deck made from known card counts', () => {
    expect(validateInitialCards(null)).toBe(false);
    expect(validateInitialCards('deck')).toBe(false);
    expect(validateInitialCards({ Stop: 0, x2: 1 })).toBe(true);
    expect(validateInitialCards({ Stop: 0, x2: 0 })).toBe(false);
    expect(validateInitialCards({ Bogus: 1 })).toBe(false);
    expect(validateInitialCards({ Stop: -1 })).toBe(false);
    expect(validateInitialCards({ Stop: 1.5 })).toBe(false);
    expect(validateInitialCards({ Stop: OVER_CARD_COUNT })).toBe(false);
    expect(validateInitialCards({})).toBe(false);
  });
});

describe('applyValidatedConfig', () => {
  it('applies only fields that pass validation', () => {
    const state = makeState();
    const originalTurnDuration = state.turnDuration;

    applyValidatedConfig(state, {
      winningScore: CUSTOM_WINNING_SCORE,
      turnDuration: INVALID_TURN_DURATION,
      reconnectTimeout: CUSTOM_RECONNECT_TIMEOUT,
      randomOrder: 'yes',
      initialCards: { Stop: CUSTOM_CARD_COUNT },
      enforcedDiceMode: 'digital',
      ruleset: 'classic',
    });

    expect(state.winningScore).toBe(CUSTOM_WINNING_SCORE);
    expect(state.turnDuration).toBe(originalTurnDuration);
    expect(state.reconnectTimeout).toBe(CUSTOM_RECONNECT_TIMEOUT);
    expect(state.randomOrder).toBe(true);
    expect(state.initialCards).toEqual({ Stop: CUSTOM_CARD_COUNT });
    expect(state.enforcedDiceMode).toBe('digital');
    expect(state.ruleset).toBe('classic');
  });

  it('applies nullable dice enforcement and ignores invalid enum values', () => {
    const state = makeState();
    state.enforcedDiceMode = 'digital';

    applyValidatedConfig(state, { enforcedDiceMode: null, ruleset: 'bogus' });

    expect(state.enforcedDiceMode).toBeNull();
    expect(state.ruleset).toBe('modernized');
  });
});
