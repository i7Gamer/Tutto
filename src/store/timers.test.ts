/**
 * Unit tests for the timer slice (src/store/timers.ts). The module-level
 * interval handles live outside Zustand state, so the headline risk tested
 * here is orphaned handles: every (re)start path must clear its predecessor,
 * or a leaked interval keeps mutating the store forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, _resetTimersForTests } from './useGameStore';

const startedOnlineTurnState = {
  mode: 'online' as const,
  isOnline: true,
  status: 'playing' as const,
  finished: false,
  currentPlayerIndex: 0,
  currentCard: null,
  turnDuration: 60,
  gameTimeInSeconds: 0,
  gameStartTime: Date.now(),
};

describe('timer slice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.getState().reset();
    _resetTimersForTests();
    // jsdom's localStorage.setItem schedules an internal one-shot setTimeout
    // (its storage-event dispatch task), so the persistence subscriber's
    // write during reset() leaves a phantom pending timer behind. Discard it
    // so the absolute getTimerCount() assertions below only ever see the
    // timer slice's own handles. (The online-mode tests trigger no further
    // localStorage writes — both persistence subscribers return early there.)
    vi.clearAllTimers();
  });

  afterEach(() => {
    _resetTimersForTests();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('startLocalTimers / stopLocalTimers', () => {
    it('ticks gameTimeInSeconds from gameStartTime while a local game runs', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();

      vi.advanceTimersByTime(3000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(3);
    });

    it('replaces the interval on repeated calls instead of stacking handles', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();
      const timersAfterOneStart = vi.getTimerCount();

      for (let i = 0; i < 5; i++) useGameStore.getState().startLocalTimers();
      expect(vi.getTimerCount()).toBe(timersAfterOneStart);
    });

    it('stopLocalTimers freezes the clock', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();
      vi.advanceTimersByTime(2000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(2);

      useGameStore.getState().stopLocalTimers();
      vi.advanceTimersByTime(5000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(2);
    });

    it('does not tick outside an active local game (lobby / finished / online)', () => {
      useGameStore.setState({
        mode: 'online', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();
      vi.advanceTimersByTime(3000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
    });
  });

  describe('syncOnlineTimers', () => {
    it('rapid repeated calls leave no orphaned interval handles', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(30);
      const timersAfterOneSync = vi.getTimerCount();

      for (let i = 0; i < 10; i++) useGameStore.getState().syncOnlineTimers(30);
      expect(vi.getTimerCount()).toBe(timersAfterOneSync);
    });

    it('a leaked handle would double-tick the countdown — resyncs must not change the decrement rate', () => {
      useGameStore.setState(startedOnlineTurnState);
      // Several resyncs to the same server value (as arriving gameState
      // events do); if any previous countdown interval survived, the ticks
      // below would decrement more than once per second.
      for (let i = 0; i < 5; i++) useGameStore.getState().syncOnlineTimers(30);

      vi.advanceTimersByTime(4000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(26);
    });

    it('adopts the server-provided remaining turn time and counts down to 0, then stops', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(3);
      expect(useGameStore.getState().turnTimeRemaining).toBe(3);

      vi.advanceTimersByTime(1000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(2);

      // The display countdown floors at 0 and waits for the server's
      // authoritative gameState — it must never go negative.
      vi.advanceTimersByTime(10_000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
    });

    it('falls back to the card-effective full duration for a new turn without a server value', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('a classic mid-chain draw of the same card type still restarts the countdown', () => {
      // The card VALUE cannot see a same-type draw (a '300' chain drawing
      // another '300') — the deck shrinking is what tells a real draw apart.
      useGameStore.setState({ ...startedOnlineTurnState, currentCard: '300', cards: ['300', '200'] });
      useGameStore.getState().syncOnlineTimers();
      vi.advanceTimersByTime(40_000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(20);

      useGameStore.setState({ currentCard: '300', cards: ['200'] });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('a card change without a deck or player change does not restart the countdown', () => {
      // Mirrors the server trigger: every legitimate card change comes with a
      // player change (nextTurn, undo) or a deck change (mid-chain draw); a
      // bare card flip must not grant fresh time.
      useGameStore.setState({ ...startedOnlineTurnState, currentCard: '300', cards: ['200'] });
      useGameStore.getState().syncOnlineTimers();
      vi.advanceTimersByTime(10_000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(50);

      useGameStore.setState({ currentCard: '400' });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(50);
    });

    it('turnDuration 0 (timer disabled) clears the countdown', () => {
      useGameStore.setState({ ...startedOnlineTurnState, turnDuration: 0 });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBeNull();
    });

    it('a finished game clears the countdown and stops all handles', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(30);

      useGameStore.setState({ finished: true });
      useGameStore.getState().syncOnlineTimers();

      expect(useGameStore.getState().turnTimeRemaining).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('re-anchors the online game clock to the server-reported elapsed seconds', () => {
      useGameStore.setState({
        ...startedOnlineTurnState, turnDuration: 0, gameTimeInSeconds: 100, gameStartTime: null,
      });
      useGameStore.getState().syncOnlineTimers();

      vi.advanceTimersByTime(2000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(102);
    });
  });

  describe('stopOnlineTimers', () => {
    it('clears both the game clock and the turn countdown', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(30);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      useGameStore.getState().stopOnlineTimers();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(5000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(30);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
    });
  });
});
