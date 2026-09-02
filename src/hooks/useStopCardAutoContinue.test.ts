import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStopCardAutoContinue, type UseStopCardAutoContinueOptions } from './useStopCardAutoContinue';
import { CARD_FLIP_MS, STOP_CARD_AUTO_CONTINUE_MS } from '../utils/uiTimings';
import { playBuzzer } from '../utils/soundEffects';
import type { CardType } from '../types';

vi.mock('../utils/soundEffects', () => ({ playBuzzer: vi.fn() }));

const STOP: CardType = 'Stop';
const DECK_SIZE = 5;

describe('useStopCardAutoContinue', () => {
  const base = (over: Partial<UseStopCardAutoContinueOptions> = {}): UseStopCardAutoContinueOptions => ({
    currentCard: STOP,
    cardsLength: DECK_SIZE,
    isOnline: true,
    isMyTurn: true,
    showDiceGame: false,
    onAutoContinue: vi.fn(),
    ...over,
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sounds the buzzer only once the card has finished flipping', () => {
    renderHook(() => useStopCardAutoContinue(base()));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS - 1));
    expect(playBuzzer, 'the flip is still playing').not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(playBuzzer).toHaveBeenCalledTimes(1);
  });

  it('advances the turn after the flip plus the auto-continue delay', () => {
    const onAutoContinue = vi.fn();
    renderHook(() => useStopCardAutoContinue(base({ onAutoContinue })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS - 1));
    expect(onAutoContinue).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onAutoContinue).toHaveBeenCalledTimes(1);
  });

  it('buzzes but never advances the turn for a player who is only watching', () => {
    const onAutoContinue = vi.fn();
    renderHook(() => useStopCardAutoContinue(base({ isMyTurn: false, onAutoContinue })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(playBuzzer).toHaveBeenCalledTimes(1);
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it('leaves a local game waiting for its Continue button', () => {
    const onAutoContinue = vi.fn();
    renderHook(() => useStopCardAutoContinue(base({ isOnline: false, onAutoContinue })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(playBuzzer, 'everyone at the table still hears it').toHaveBeenCalledTimes(1);
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it('does nothing at all while the dice panel is up — that forfeit is DiceGame\'s to commit', () => {
    const onAutoContinue = vi.fn();
    renderHook(() => useStopCardAutoContinue(base({ showDiceGame: true, onAutoContinue })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(playBuzzer).not.toHaveBeenCalled();
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it('does nothing for any other card', () => {
    const onAutoContinue = vi.fn();
    renderHook(() => useStopCardAutoContinue(base({ currentCard: '300', onAutoContinue })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(playBuzzer).not.toHaveBeenCalled();
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it('buzzes again for a SECOND Stop, which the deck size is the only witness to', () => {
    const { rerender } = renderHook(
      (props: UseStopCardAutoContinueOptions) => useStopCardAutoContinue(props),
      { initialProps: base() },
    );

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));
    expect(playBuzzer).toHaveBeenCalledTimes(1);

    // currentCard is still 'Stop' — only the shrinking deck says a new card
    // was drawn.
    rerender(base({ cardsLength: DECK_SIZE - 1 }));
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));
    expect(playBuzzer).toHaveBeenCalledTimes(2);
  });

  it('exposes a countdown for the online active player, starting once the flip finishes', () => {
    const { result } = renderHook(() => useStopCardAutoContinue(base()));

    expect(result.current, 'nothing to show until the flip finishes').toBeNull();

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS));
    expect(result.current).toBe(STOP_CARD_AUTO_CONTINUE_MS / 1000);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(STOP_CARD_AUTO_CONTINUE_MS / 1000 - 1);
  });

  it('exposes no countdown for a player who is only watching', () => {
    const { result } = renderHook(() => useStopCardAutoContinue(base({ isMyTurn: false })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(result.current).toBeNull();
  });

  it('exposes no countdown for a local (offline) game', () => {
    const { result } = renderHook(() => useStopCardAutoContinue(base({ isOnline: false })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(result.current).toBeNull();
  });

  it('exposes no countdown while the dice panel is open', () => {
    const { result } = renderHook(() => useStopCardAutoContinue(base({ showDiceGame: true })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(result.current).toBeNull();
  });

  it('exposes no countdown for any card other than Stop', () => {
    const { result } = renderHook(() => useStopCardAutoContinue(base({ currentCard: '300' })));

    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));
    expect(result.current).toBeNull();
  });

  it('cancels both timers when the card leaves before they fire', () => {
    const onAutoContinue = vi.fn();
    const { rerender } = renderHook(
      (props: UseStopCardAutoContinueOptions) => useStopCardAutoContinue(props),
      { initialProps: base({ onAutoContinue }) },
    );

    rerender(base({ currentCard: '300', onAutoContinue }));
    act(() => vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS));

    expect(playBuzzer).not.toHaveBeenCalled();
    expect(onAutoContinue).not.toHaveBeenCalled();
  });
});
