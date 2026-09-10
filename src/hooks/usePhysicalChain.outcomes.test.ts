import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePhysicalChain } from './usePhysicalChain';
import type { CardType } from '../types';

const initial = {
  enabled: true, roomId: 'OUTCOMES', round: 1, currentPlayerIndex: 0,
  currentCard: '200' as CardType, ruleset: 'classic' as const, scoreInput: '500',
};
beforeEach(() => { localStorage.clear(); });

describe('physical outcome journal', () => {
  it('publishes a fixed award atomically before the parent score input rerenders', () => {
    const onSnapshot = vi.fn();
    const { result } = renderHook(() => usePhysicalChain({
      ...initial, currentCard: 'Plus_Minus', scoreInput: '0', onSnapshot,
    }));
    onSnapshot.mockClear();
    act(() => result.current.completeCurrentCard(true));
    for (const [snapshot] of onSnapshot.mock.calls) {
      expect(snapshot).toMatchObject({ turnScore: 1000, lastCardCompleted: true,
        cardOutcomes: [{ card: 'Plus_Minus', scoreBefore: 0, scoreAfter: 1000, tuttos: 1 }] });
    }
    expect(onSnapshot).toHaveBeenCalled();
  });

  it('preserves each completed card boundary through a draw and reload', () => {
    const { result, rerender, unmount } = renderHook(props => usePhysicalChain(props), { initialProps: initial });
    act(() => result.current.recordDraw('Plus_Minus', '200'));
    rerender({ ...initial, currentCard: 'Plus_Minus' });
    act(() => result.current.completeCurrentCard(true));
    rerender({ ...initial, currentCard: 'Plus_Minus', scoreInput: '1500' });
    expect(result.current.buildSummary('banked', true).outcomes).toEqual([
      { card: '200', scoreBefore: 0, scoreAfter: 500, tuttos: 1 },
      { card: 'Plus_Minus', scoreBefore: 500, scoreAfter: 1500, tuttos: 1 },
    ]);
    unmount();
    const resumed = renderHook(() => usePhysicalChain({ ...initial, currentCard: 'Plus_Minus', scoreInput: '1500' }));
    expect(resumed.result.current.buildSummary('banked', true).outcomes?.[0].scoreAfter).toBe(500);
  });

  it('reports the bank at risk before Stop forfeits it', () => {
    const { result, rerender } = renderHook(props => usePhysicalChain(props), { initialProps: initial });
    act(() => result.current.recordDraw('Stop', '200'));
    rerender({ ...initial, currentCard: 'Stop' });
    expect(result.current.buildSummary('stopCard', false, 500).outcomes).toEqual([
      { card: '200', scoreBefore: 0, scoreAfter: 500, tuttos: 1 },
      { card: 'Stop', scoreBefore: 500, scoreAfter: 500, tuttos: 0 },
    ]);
  });
});
