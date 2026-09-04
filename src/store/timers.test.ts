/**
 * Unit tests for the timer slice (src/store/timers.ts). The module-level
 * interval handles live outside Zustand state, so the headline risk tested
 * here is orphaned handles: every (re)start path must clear its predecessor,
 * or a leaked interval keeps mutating the store forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, _resetTimersForTests } from './useGameStore';
import { clearRoomState } from './socketSlice';

// What syncOnlineTimers leaves running for a started online turn: the game
// clock and the turn countdown. stopOnlineTimers owns both, and endGame has to
// take both down in one go — see its test below.
const ONLINE_TIMER_HANDLES = 2;

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

  // A3: the countdown used to decrement turnTimeRemaining by 1 per interval
  // tick, so a throttled/backgrounded tab that misses ticks left the display
  // stuck on a stale number (measured: 54s shown while the server had 14s
  // left). It is now deadline-anchored — every tick (and every
  // visibilitychange back to 'visible') recomputes turnTimeRemaining from
  // Date.now() against a stored turnDeadline, so a missed tick self-corrects
  // instead of compounding.
  describe('deadline-anchored turn countdown', () => {
    it('sets turnDeadline alongside turnTimeRemaining on every countdown restart', () => {
      useGameStore.setState(startedOnlineTurnState);
      const before = Date.now();

      useGameStore.getState().syncOnlineTimers(45);

      expect(useGameStore.getState().turnDeadline).toBe(before + 45_000);
    });

    it('derives the next tick from the deadline instead of decrementing — a system-time jump (throttled background tab) is caught immediately', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(60);
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);

      // Simulate a background tab: real time passes but no interval callback
      // fires while it does (vi.setSystemTime jumps the clock without running
      // any pending timers).
      vi.setSystemTime(Date.now() + 40_000);

      // Let the already-scheduled interval fire its next tick (fake timers
      // still require ticking the clock forward by the interval's own
      // period to reach it — real background tabs simply skip firing
      // entirely, which the visibilitychange listener below covers). A naive
      // decrement would read 59 (one tick, minus one); the deadline-anchored
      // tick reads the true elapsed time instead.
      vi.advanceTimersByTime(1000);
      expect(useGameStore.getState().turnTimeRemaining).toBe(19);
    });

    it('a visibilitychange to "visible" ticks immediately instead of waiting for the interval', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(60);

      vi.setSystemTime(Date.now() + 40_000);
      // jsdom documents default to visibilityState 'visible'; dispatching the
      // event alone (no interval tick, no advanceTimersByTime) must recompute.
      document.dispatchEvent(new Event('visibilitychange'));

      expect(useGameStore.getState().turnTimeRemaining).toBe(20);
    });

    it('does not tick on a visibilitychange while the tab is hidden', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(60);

      vi.setSystemTime(Date.now() + 40_000);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
      vi.restoreAllMocks();
    });

    it('registers the visibilitychange listener when the countdown starts and removes it when stopOnlineTimers runs', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(60);
      expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

      useGameStore.getState().stopOnlineTimers();
      expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('never reports a negative remaining time, even long past the deadline', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(5);

      vi.advanceTimersByTime(10 * 60_000);

      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
    });

    it('reset() clears turnDeadline', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(45);
      expect(useGameStore.getState().turnDeadline).not.toBeNull();

      useGameStore.getState().reset();
      expect(useGameStore.getState().turnDeadline).toBeNull();
    });

    it('clearRoomState clears turnDeadline', () => {
      expect(clearRoomState().turnDeadline).toBeNull();
    });

    // The countdown's only self-stop used to sit BELOW the `deadline === null`
    // early-out, so the one thing that branch means — there is nothing left to
    // count — was also the one thing that could not stop the 1 Hz interval.
    // Every writer that nulls turnDeadline without clearing first (endGame,
    // clearRoomState via leaveRoom/kicked/reset) therefore stranded a
    // permanent interval that re-entered this callback once a second for the
    // rest of the session.
    it('clears its own interval when the deadline is taken away underneath it', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(60);
      const withCountdown = vi.getTimerCount();
      expect(withCountdown).toBeGreaterThan(0);

      useGameStore.setState({ turnDeadline: null });
      vi.advanceTimersByTime(1000);

      expect(vi.getTimerCount(), 'the countdown must retire itself').toBe(withCountdown - 1);

      // And stay retired — a handle that survives one tick survives forever.
      vi.advanceTimersByTime(10_000);
      expect(vi.getTimerCount()).toBe(withCountdown - 1);
    });
  });

  // syncOnlineTimers accepted anything `typeof serverRemaining === 'number'`,
  // and NaN is one: it made turnDeadline NaN, and Math.ceil(NaN) is never
  // <= 0, so the countdown's own kill switch never fired — the 1 Hz interval
  // ran for the rest of the session over a tile rendering "NaNs".
  describe('a garbled server turn time is treated as no value at all', () => {
    const MS_PER_SECOND = 1000;
    const RUNNING_TURN_SECONDS = 60;
    const CORRECTED_TURN_SECONDS = 20;
    const PAST_THE_DEADLINE_MS = (RUNNING_TURN_SECONDS + 1) * MS_PER_SECOND;
    // What is left running once the countdown retires: the game clock alone.
    const GAME_CLOCK_ONLY = ONLINE_TIMER_HANDLES - 1;

    // A countdown already running on a good value — the state a garbled one
    // arrives into, and the only state in which "ignored" is observable
    // (nothing else here would restart the countdown).
    const runningTurn = (): number => {
      const startedAt = Date.now();
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(RUNNING_TURN_SECONDS);
      return startedAt;
    };

    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a negative value', -1],
    ])('ignores %s and leaves the running countdown untouched', (_label, garbled) => {
      const startedAt = runningTurn();

      useGameStore.getState().syncOnlineTimers(garbled);

      expect(useGameStore.getState().turnTimeRemaining).toBe(RUNNING_TURN_SECONDS);
      expect(useGameStore.getState().turnDeadline).toBe(startedAt + RUNNING_TURN_SECONDS * MS_PER_SECOND);
    });

    it('lets the countdown retire on its real deadline instead of counting NaN forever', () => {
      runningTurn();
      useGameStore.getState().syncOnlineTimers(NaN);

      vi.advanceTimersByTime(PAST_THE_DEADLINE_MS);

      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
      expect(vi.getTimerCount(), 'the countdown must still retire itself').toBe(GAME_CLOCK_ONLY);
    });

    it('still restarts the countdown from a valid value', () => {
      runningTurn();
      const correctedAt = Date.now();

      useGameStore.getState().syncOnlineTimers(CORRECTED_TURN_SECONDS);

      expect(useGameStore.getState().turnTimeRemaining).toBe(CORRECTED_TURN_SECONDS);
      expect(useGameStore.getState().turnDeadline).toBe(correctedAt + CORRECTED_TURN_SECONDS * MS_PER_SECOND);
    });

    it('treats a zero as the value it is — the server saying the turn is out of time', () => {
      runningTurn();

      useGameStore.getState().syncOnlineTimers(0);

      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
    });
  });

  describe('endGame', () => {
    // endGame stopped only the LOCAL timers and left turnDeadline set, so the
    // surviving 1 Hz countdown re-derived turnTimeRemaining from that deadline
    // one second later — silently undoing endGame's own `turnTimeRemaining:
    // null` and leaving a live countdown ticking over the lobby.
    it('stops the online countdown instead of letting it re-derive the time it just cleared', () => {
      useGameStore.setState({ ...startedOnlineTurnState, isHost: true });
      useGameStore.getState().syncOnlineTimers(60);
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
      const withCountdown = vi.getTimerCount();
      expect(withCountdown, 'both online handles must be running before this means anything').toBe(ONLINE_TIMER_HANDLES);

      useGameStore.getState().endGame();
      // endGame flips the store to `status: 'lobby'`, which is exactly the
      // transition the online-config persistence subscriber writes on — and
      // jsdom's localStorage.setItem schedules its storage-event dispatch as a
      // 0 ms task (see the beforeEach). Draining that costs nothing here: a
      // 1 Hz interval cannot fire in zero milliseconds, so a countdown that
      // survived endGame is still standing after this line.
      vi.advanceTimersByTime(0);

      // The handle count, not the state, is what this call actually buys.
      // Every turnTimeRemaining/turnDeadline assertion below passes with
      // endGame's stopOnlineTimers() deleted, because the countdown's own kill
      // switch (tested above) retires the survivor when it finds turnDeadline
      // null on its next tick — so the state is identical one second later
      // either way, and only the handle count can see the second in between.
      // What lives in that second is more than a stray handle: clearTurnTimer
      // is also the only thing that forgets turnTimerPlayerIndex/
      // turnTimerDeckSize, so a game started inside it reaches
      // syncOnlineTimers with the ENDED game's turn tracking still in place —
      // same player index, same deck size, so neither playerChanged nor
      // deckChanged fires and the new game's first turn gets no countdown at
      // all before the stale interval clears itself.
      expect(vi.getTimerCount(), 'the countdown must stop now, not on its next tick').toBe(
        withCountdown - ONLINE_TIMER_HANDLES,
      );

      expect(useGameStore.getState().turnTimeRemaining).toBeNull();
      expect(useGameStore.getState().turnDeadline, 'a deadline outlives the game it belonged to').toBeNull();

      vi.advanceTimersByTime(5000);
      expect(
        useGameStore.getState().turnTimeRemaining,
        'a surviving interval undoes endGame one tick later',
      ).toBeNull();
    });
  });

  // stopOnlineTimers owns BOTH module handles; the turn countdown's own
  // self-stop (above) covers only one of them. A teardown path that skips it
  // therefore leaks the game clock, which writes gameTimeInSeconds with no
  // mode check at all — straight into whatever game comes next.
  describe('teardown paths stop the online game clock', () => {
    // Puts a game clock in front of a leaked interval: gameTimeInSeconds is
    // only written while gameStartTime is set, so the leak is invisible until
    // the next game anchors one.
    const nextGameStartsTicking = () => {
      useGameStore.setState({ gameStartTime: Date.now() - 30_000 });
      vi.advanceTimersByTime(2000);
    };

    it('reset() stops it, so it cannot write into the fresh state', () => {
      useGameStore.setState(startedOnlineTurnState);
      useGameStore.getState().syncOnlineTimers(45);

      useGameStore.getState().reset();
      nextGameStartsTicking();

      expect(useGameStore.getState().gameTimeInSeconds, 'a leaked interval keeps writing the clock').toBe(0);
    });

    it('cancelReconnect stops it when it abandons a joined room', () => {
      useGameStore.setState({ ...startedOnlineTurnState, roomId: 'ROOM1', myName: 'Alice' });
      useGameStore.getState().syncOnlineTimers(45);

      useGameStore.getState().cancelReconnect();
      nextGameStartsTicking();

      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
    });

    // The other side of that stop: declining the restore prompt on a fresh
    // page load calls cancelReconnect with no room in the store, and the local
    // game init() just restored is running on the very same handle. Stopping
    // unconditionally would freeze its clock.
    it('cancelReconnect leaves a restored local game running when there is no room to abandon', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();

      useGameStore.getState().cancelReconnect(null, null);
      vi.advanceTimersByTime(2000);

      expect(useGameStore.getState().gameTimeInSeconds).toBe(2);
    });
  });
});
