/**
 * @vitest-environment node
 *
 * In-process unit tests for the server-authoritative turn timer in
 * turnTimers.ts. turnTimer.test.ts (spawned subprocess) proves the same
 * behavior end-to-end over a real socket, but the subprocess boundary means
 * none of that file's coverage shows up here — these tests exercise the
 * exported functions directly against the shared `rooms` registry with a
 * stub `io`, and they can reach branches E2E structurally cannot: a
 * corrupted room state that pushState's own validation should make
 * unreachable in production (the try/catch backstop in advanceTurnOnTimeout).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'socket.io';
import { rooms, createRoom } from './rooms';
import { clearServerTurnTimer, startServerTurnTimer, advanceTurnOnTimeout, abortGameIfLowPlayers } from './turnTimers';
import type { ServerPlayer } from './roomTypes';

const makePlayer = (name: string, overrides: Partial<ServerPlayer> = {}): ServerPlayer => ({
  name,
  deviceId: `dev-${name}`,
  socketId: `sock-${name}`,
  score: 0,
  times1000PointsDeducted: 0,
  timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0,
  timesKniffelFailed: 0,
  timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0,
  timesPlusMinusFailed: 0,
  timesFeuerwerkReceived: 0,
  timesSkipped: 0,
  timesx2Received: 0,
  totalTurns: 0,
  busts: 0,
  feuerwerkBusts: 0,
  x2Busts: 0,
  feuerwerkPointsScored: 0,
  x2PointsScored: 0,
  position: 0,
  color: '#ff0000',
  disconnected: false,
  ...overrides,
});

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, emit, to };
};

const roomId = 'timer-unit-room';

// vite.config.js sets TEST_TIMER_SCALE for the whole suite to accelerate the
// spawned-server integration tests, and startServerTurnTimer applies it here
// too — so a turn nominally lasting N seconds is armed for N * scale. Tests that
// advance the fake clock must scale with it, mirroring turnTimers.ts exactly:
// advancing a raw, unscaled duration overshoots the real deadline and lets the
// timer re-arm and fire repeatedly instead of not firing at all.
const TIMER_SCALE = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
const scaledTimeoutMs = (seconds: number) => Math.max(10, Math.floor(seconds * 1000 * TIMER_SCALE));

describe('turnTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    delete rooms[roomId];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete rooms[roomId];
  });

  describe('clearServerTurnTimer', () => {
    it('does nothing when the room does not exist', () => {
      expect(() => clearServerTurnTimer(roomId)).not.toThrow();
    });

    it('does nothing when the room has no pending timer', () => {
      rooms[roomId] = createRoom('host-1');
      expect(() => clearServerTurnTimer(roomId)).not.toThrow();
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('clears a pending timer', () => {
      rooms[roomId] = createRoom('host-1');
      rooms[roomId].turnExpireTimer = setTimeout(() => {}, 10000);
      clearServerTurnTimer(roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });
  });

  describe('startServerTurnTimer', () => {
    it('does nothing when the room does not exist', () => {
      const { io } = makeFakeIo();
      expect(() => startServerTurnTimer(io, roomId)).not.toThrow();
    });

    it('does not schedule when status is not playing', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', currentPlayerIndex: 0, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when the game is finished', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', finished: true, currentPlayerIndex: 0, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when currentPlayerIndex is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: null, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when turnDuration is 0', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: 0, turnDuration: 0, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when turnStartTime is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: 0, turnDuration: 60, turnStartTime: null });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('schedules a timeout for the remaining duration and does not fire early', () => {
      const TURN_DURATION_SECONDS = 30;
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: TURN_DURATION_SECONDS, turnStartTime: Date.now(),
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).not.toBeNull();

      // Straddle the deadline rather than picking a value inside the turn: one
      // tick short must not fire, and the very next tick must. Asserting only
      // the "before" half is what made this fragile — with the scaled deadline
      // the old 29s advance fired the timer four times (6s, 12s, 18s, 24s), and
      // the assertion still held purely because two players and an even number
      // of advances cycled currentPlayerIndex back to 0.
      const deadlineMs = scaledTimeoutMs(TURN_DURATION_SECONDS);
      vi.advanceTimersByTime(deadlineMs - 1);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(0); // not advanced yet

      vi.advanceTimersByTime(1);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(1); // fires exactly on the deadline
    });

    it('re-arming clears the previous timer first (safe to call repeatedly)', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: 30, turnStartTime: Date.now(),
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      const firstTimer = rooms[roomId].turnExpireTimer;
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).not.toBe(firstTimer);
    });

    it('advances immediately (synchronously) when the remaining time is already <= 0', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: 10,
        turnStartTime: Date.now() - 20_000, // already expired
        players: [makePlayer('Alice'), makePlayer('Bob')],
        currentCard: '200', cards: ['300'],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      // advanceTurnOnTimeout ran synchronously — the turn has already moved on,
      // and no timer is left pending for the expired turn.
      expect(rooms[roomId].state.currentPlayerIndex).toBe(1);
    });
  });

  describe('advanceTurnOnTimeout', () => {
    it('does nothing when the room no longer exists (deleted mid-flight)', () => {
      const { io, emit } = makeFakeIo();
      expect(() => advanceTurnOnTimeout(io, roomId)).not.toThrow();
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when the game is already finished', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', finished: true, currentPlayerIndex: 0 });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when status is not playing', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', currentPlayerIndex: 0 });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when currentPlayerIndex is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: null });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('treats the timeout as a bust (no manual action taken) and advances to the next player', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);

      const state = rooms[roomId].state;
      expect(state.currentPlayerIndex).toBe(1);
      expect(state.players[0].busts).toBe(1);
      expect(state.previousCard).toBe('200');
      expect(state.previousScore).toBe(0);
      expect(emit).toHaveBeenCalledWith('gameState', expect.any(Object));
      expect(emit).toHaveBeenCalledWith('hostId', 'host-1');
    });

    it('schedules the next turn timer via the recursive re-arm when the game continues', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, turnDuration: 45,
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);
      // The just-advanced turn (now player 1) has its own fresh expiry armed.
      expect(rooms[roomId].turnExpireTimer).not.toBeNull();
      expect(rooms[roomId].turnTimerState?.lastPlayerIndex).toBe(1);
    });

    it('finishes the game and clears gameActualStartTime when the timeout ends the game', () => {
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      room.gameActualStartTime = Date.now() - 5000;
      Object.assign(room.state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: [],
        round: 1, winningScore: 100,
        players: [{ ...makePlayer('Alice'), score: 100 }],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(room.state.finished).toBe(true);
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.currentCard).toBeNull();
      expect(room.state.turnStartTime).toBeNull();
      expect(room.gameActualStartTime).toBeNull();
      expect(room.state.gameTimeInSeconds).toBeGreaterThanOrEqual(5);
      expect(room.turnExpireTimer).toBeNull(); // no further timer scheduled once over
    });

    it('pushes a chart datapoint when the timeout ends the round', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 1, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        chartValues: [[0], [0]], chartLabels: [],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.chartValues[0].length).toBe(2);
      expect(rooms[roomId].state.chartValues[1].length).toBe(2);
      expect(rooms[roomId].state.chartLabels).toEqual([1]);
      expect(rooms[roomId].state.round).toBe(2);
    });

    it('skips the round-end datapoint when the chart series are out of step with the roster', () => {
      // chartLabels is round-indexed and chartValues is player-indexed, so a
      // label may only be appended when the series it labels were appended
      // too. handleActivePlayerRemoved gates its identical round-end
      // bookkeeping this way; this path did not, so a roster/series mismatch
      // grew chartLabels past every series and skewed the end-screen chart.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 1, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        chartValues: [], chartLabels: [],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.chartLabels).toEqual([]);
      // The turn itself still advances — only the chart bookkeeping is skipped.
      expect(rooms[roomId].state.round).toBe(2);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(0);
    });

    it('reconstructs a classic chain forfeit from the live snapshot, counting every chain card', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 1800, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 2,
          cardsThisTurn: ['500', 'Kniffel', 'Feuerwerk'],
          plusMinusSuccesses: 0,
          chainTuttoCount: 2,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      const alice = state.players[0];
      expect(state.currentPlayerIndex).toBe(1);
      expect(alice.busts).toBe(1);
      expect(alice.timesKniffelCompleted).toBe(1);   // completed mid-chain
      expect(alice.timesFeuerwerkReceived).toBe(1);  // the card the chain died on
      expect(alice.totalTuttos).toBe(2);
      expect(alice.mostCardsInTurn).toBe(3);
      expect(alice.highestForfeitedTurnScore).toBe(1800);
      expect(state.previousScore).toBe(0);
      expect(state.previousTurnSummary?.cards.map(c => c.card)).toEqual(['500', 'Kniffel', 'Feuerwerk']);
      const lastEntry = state.historyLog[state.historyLog.length - 1];
      expect(lastEntry.type).toBe('bust');
      expect(lastEntry.cards).toEqual(['500', 'Kniffel', 'Feuerwerk']);
    });

    it('classifies a timeout during a drawn-Stop summary as the Stop forfeit, not a dice bust', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Stop', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 800, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 1,
          cardsThisTurn: ['300', 'Stop'],
          plusMinusSuccesses: 0,
          chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesSkipped).toBe(1);
      expect(alice.highestForfeitedTurnScore).toBe(800);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('stopCard');
    });

    it('keeps the legacy timeout behavior when the snapshot carries no chain (modernized / physical)', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 100, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      expect(state.players[0].busts).toBe(1);
      expect(state.previousTurnSummary).toBeNull();
      const lastEntry = state.historyLog[state.historyLog.length - 1];
      expect(lastEntry.type).toBe('bust');
      expect(lastEntry.cards).toBeUndefined();
    });

    it('backstop: swallows an exception from a corrupted room state instead of crashing the process', () => {
      // Real pushState validation (pushValidation.ts) should make an
      // out-of-bounds currentPlayerIndex unreachable, but this handler runs off
      // a bare setTimeout with no caller to catch a throw — an uncaught
      // exception here would otherwise crash the whole process (every room,
      // every player), not just this one room's turn.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 5, // out of bounds for a 1-player roster
        players: [makePlayer('Alice')],
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { io, emit } = makeFakeIo();

      expect(() => advanceTurnOnTimeout(io, roomId)).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[turnTimer] Failed to advance turn for room ${roomId}`),
        expect.any(Error),
      );
      // The broadcast never fires for a failed advance.
      expect(emit).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('abortGameIfLowPlayers', () => {
    it('returns false and leaves state untouched when there are enough players', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', players: [makePlayer('Alice'), makePlayer('Bob')] });
      const { io, emit } = makeFakeIo();
      const aborted = abortGameIfLowPlayers(io, rooms[roomId], roomId);
      expect(aborted).toBe(false);
      expect(rooms[roomId].state.status).toBe('playing');
      expect(emit).not.toHaveBeenCalled();
    });

    it('returns false when not currently playing, even with fewer than 2 players', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', players: [makePlayer('Alice')] });
      const { io } = makeFakeIo();
      expect(abortGameIfLowPlayers(io, rooms[roomId], roomId)).toBe(false);
    });

    it('returns false for a finished game (end screen), even with fewer than 2 players', () => {
      // A finished game stays status 'playing' (finished=true) through the end
      // screen — the last remaining player's peer leaving/being kicked there
      // must not wipe their end screen or fire a misleading "game aborted" toast.
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      Object.assign(room.state, {
        status: 'playing', finished: true, players: [makePlayer('Alice')],
        currentCard: null, currentPlayerIndex: null,
      });
      const { io, emit } = makeFakeIo();
      expect(abortGameIfLowPlayers(io, room, roomId)).toBe(false);
      expect(room.state.status).toBe('playing');
      expect(room.state.finished).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });

    it('aborts the game, resets play state, clears the timer, and emits gameAborted', () => {
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      room.gameActualStartTime = Date.now();
      room.turnTimerState = { lastCard: '200', lastPlayerIndex: 0 };
      room.turnExpireTimer = setTimeout(() => {}, 10000);
      Object.assign(room.state, {
        status: 'playing', players: [makePlayer('Alice')], currentCard: '200', currentPlayerIndex: 0,
        finished: false, turnStartTime: Date.now(),
      });
      const { io, emit, to } = makeFakeIo();
      const aborted = abortGameIfLowPlayers(io, room, roomId);

      expect(aborted).toBe(true);
      expect(to).toHaveBeenCalledWith(roomId);
      expect(emit).toHaveBeenCalledWith('gameAborted');
      expect(room.state.status).toBe('lobby');
      expect(room.state.currentCard).toBeNull();
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.finished).toBe(false);
      expect(room.state.turnStartTime).toBeNull();
      expect(room.gameActualStartTime).toBeNull();
      expect(room.turnTimerState?.lastCard).toBeNull();
      expect(room.turnTimerState?.lastPlayerIndex).toBeNull();
      expect(room.turnExpireTimer).toBeNull();
    });
  });
});
