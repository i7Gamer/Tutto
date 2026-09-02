import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import confetti from 'canvas-confetti';
import { useFeuerwerkFanfare } from './useFeuerwerkFanfare';
import { CARD_FLIP_MS } from '../utils/uiTimings';
import { playSuccess } from '../utils/soundEffects';
import type { CardType } from '../types';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));
vi.mock('../utils/soundEffects', () => ({ playSuccess: vi.fn() }));

const FEUERWERK: CardType = 'Feuerwerk';
const DECK_SIZE = 7;

interface Props { card: CardType | null; deck: number | undefined }

const renderFanfare = (initialProps: Props) => renderHook(
  ({ card, deck }: Props) => useFeuerwerkFanfare(card, deck),
  { initialProps },
);

describe('useFeuerwerkFanfare', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('celebrates only once the card has finished flipping', () => {
    renderFanfare({ card: FEUERWERK, deck: DECK_SIZE });

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS - 1));
    expect(confetti, 'the flip is still playing').not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(confetti).toHaveBeenCalledTimes(1);
    expect(playSuccess).toHaveBeenCalledTimes(1);
  });

  it('throws a wide burst from just below the middle of the screen', () => {
    renderFanfare({ card: FEUERWERK, deck: DECK_SIZE });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    expect(confetti).toHaveBeenCalledWith(expect.objectContaining({
      particleCount: expect.any(Number),
      spread: expect.any(Number),
      origin: { y: expect.any(Number) },
    }));
    const [{ origin }] = vi.mocked(confetti).mock.calls[0] as [{ origin: { y: number } }];
    expect(origin.y).toBeGreaterThan(0.5);
    expect(origin.y).toBeLessThan(1);
  });

  it('stays quiet for every other card', () => {
    renderFanfare({ card: '300', deck: DECK_SIZE });

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));
    expect(confetti).not.toHaveBeenCalled();
    expect(playSuccess).not.toHaveBeenCalled();
  });

  it('does not celebrate the same card twice when the component re-renders', () => {
    const { rerender } = renderFanfare({ card: FEUERWERK, deck: DECK_SIZE });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    rerender({ card: FEUERWERK, deck: DECK_SIZE });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    expect(confetti).toHaveBeenCalledTimes(1);
  });

  it('celebrates a SECOND Feuerwerk, which the deck size is the only witness to', () => {
    const { rerender } = renderFanfare({ card: FEUERWERK, deck: DECK_SIZE });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    rerender({ card: FEUERWERK, deck: DECK_SIZE - 1 });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    expect(confetti).toHaveBeenCalledTimes(2);
    expect(playSuccess).toHaveBeenCalledTimes(2);
  });

  it('cancels the burst if the card is gone before the flip finishes', () => {
    const { rerender } = renderFanfare({ card: FEUERWERK, deck: DECK_SIZE });

    rerender({ card: '300', deck: DECK_SIZE - 1 });
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));

    expect(confetti).not.toHaveBeenCalled();
  });
});
