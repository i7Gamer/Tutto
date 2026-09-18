import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SpectatorRollDie from './SpectatorRollDie';
import { DIE_FACE_SHUFFLE_MS } from '../../utils/uiTimings';

// The live snapshot carries the FINAL values of a roll from the moment it
// starts (DiceGame dispatches ROLL_STARTED with them), so a spectator used to
// see the outcome a good half-second before the active player's own dice
// settled. While a die is flagged as still rolling, this mirror paints a
// shuffling random face instead, exactly as the roll panel's displayRoll does.
describe('SpectatorRollDie', () => {
  // Math.random -> 0.99 rolls a 6 every time; the real value below is 3.
  const FACE_SIX_RANDOM = 0.99;
  const REAL_VALUE = 3;
  const SHUFFLED_VALUE = 6;
  const die = { id: 'd1', val: REAL_VALUE, selected: false };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(FACE_SIX_RANDOM);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const shownValue = () => screen.getByRole('img').textContent;

  it('never shows the final value while the die is still rolling', () => {
    render(<SpectatorRollDie die={die} isRolling={true} isBusted={false} />);
    expect(shownValue()).toBe(String(SHUFFLED_VALUE));
    act(() => { vi.advanceTimersByTime(DIE_FACE_SHUFFLE_MS * 3); });
    expect(shownValue()).toBe(String(SHUFFLED_VALUE));
  });

  it('settles on the real value once the die stops rolling', () => {
    const { rerender } = render(<SpectatorRollDie die={die} isRolling={true} isBusted={false} />);
    rerender(<SpectatorRollDie die={die} isRolling={false} isBusted={false} />);
    expect(shownValue()).toBe(String(REAL_VALUE));
    act(() => { vi.advanceTimersByTime(DIE_FACE_SHUFFLE_MS * 3); });
    expect(shownValue()).toBe(String(REAL_VALUE));
  });

  it('shows the real value straight away for a die that was never rolling', () => {
    render(<SpectatorRollDie die={die} isRolling={false} isBusted={false} />);
    expect(shownValue()).toBe(String(REAL_VALUE));
  });

  it('names the die (the test i18n mock returns the bare key)', () => {
    render(<SpectatorRollDie die={die} isRolling={true} isBusted={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'dice.dieFace');
  });

  it('stops shuffling on unmount', () => {
    const { unmount } = render(<SpectatorRollDie die={die} isRolling={true} isBusted={false} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
