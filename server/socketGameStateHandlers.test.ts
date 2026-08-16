/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'socket.io';
import { registerGameStateHandlers, MAX_TIMER_RESTARTS_PER_TURN } from './socketGameStateHandlers';
import { makeFakeSocket, type Handler } from './socketTestHarness';
import { rooms, createRoom, deleteRoom } from './rooms';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import type { ServerPlayer } from './roomTypes';

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, emit };
};

const makePlayer = (name: string, socketId: string): ServerPlayer => ({
  name,
  deviceId: `dev-${name}`,
  socketId,
  score: 0,
  position: 1,
  disconnected: false,
  ...zeroedPlayerStats(),
});

describe('pushState turn-timer restarts', () => {
  const roomId = 'TIMER-RESTART-ROOM';
  const TURN_START = 500_000;
  const PUSH_TIME = 1_000_000;
  let pushState: Handler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PUSH_TIME);
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('active-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['300', '200'],
      round: 1, turnDuration: 60, turnStartTime: TURN_START,
      players: [makePlayer('Alice', 'active-sock'), makePlayer('Bob', 'other-sock')],
    });
    // The current turn is already "seen" — only a real change may restart it.
    rooms[roomId].turnTimerState = {
      lastCard: '300', lastPlayerIndex: 0, lastDeckSize: 2, restartsThisTurn: 0,
    };

    const fake = makeFakeSocket('active-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('restarts the timer when a mid-chain draw deals the SAME card type (deck shrank)', () => {
    // A classic '300' chain drawing another '300': the card value is
    // identical, but the deck lost a card — the fresh card must get a fresh
    // deadline instead of inheriting the dying one.
    pushState({ roomId, newState: { currentCard: '300', cards: ['200'] } });

    expect(rooms[roomId].state.turnStartTime).toBe(PUSH_TIME);
    expect(rooms[roomId].turnTimerState?.restartsThisTurn).toBe(1);
  });

  it('does not restart for a card flip that changes neither player nor deck', () => {
    // The counter-abuse: a patched active player flipping currentCard back
    // and forth used to reset the deadline indefinitely, defeating the
    // server-authoritative expiry.
    pushState({ roomId, newState: { currentCard: '400' } });

    expect(rooms[roomId].state.turnStartTime).toBe(TURN_START);
  });

  it('stops granting deck-triggered restarts past the per-turn budget', () => {
    rooms[roomId].turnTimerState!.restartsThisTurn = MAX_TIMER_RESTARTS_PER_TURN;

    pushState({ roomId, newState: { currentCard: '300', cards: ['200'] } });

    expect(rooms[roomId].state.turnStartTime).toBe(TURN_START);
  });

  it('a player change always restarts and resets the budget', () => {
    rooms[roomId].turnTimerState!.restartsThisTurn = MAX_TIMER_RESTARTS_PER_TURN;

    pushState({ roomId, newState: { currentPlayerIndex: 1, currentCard: '200', cards: [] } });

    expect(rooms[roomId].state.turnStartTime).toBe(PUSH_TIME);
    expect(rooms[roomId].turnTimerState?.restartsThisTurn).toBe(0);
  });
});

describe('pushState against an already-finished game', () => {
  const roomId = 'FINISHED-CLOCK-ROOM';
  const GAME_START = 500_000;
  const GAME_END = 920_000; // 7 minutes of play
  const LATER_PUSH = 1_000_000;
  const PLAYED_SECONDS = (GAME_END - GAME_START) / 1000;
  let pushState: Handler;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('active-sock');
    // A finished game keeps status 'playing' with finished: true all the way
    // through the end screen (see the startingGame comment in pushState), and
    // the finishing push already nulled gameActualStartTime while banking the
    // elapsed time into gameTimeInSeconds.
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, currentCard: null,
      round: 5, turnDuration: 60, turnStartTime: null,
      gameTimeInSeconds: PLAYED_SECONDS,
      players: [makePlayer('Alice', 'active-sock'), makePlayer('Bob', 'other-sock')],
    });
    rooms[roomId].gameActualStartTime = null;

    const fake = makeFakeSocket('active-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
    vi.setSystemTime(LATER_PUSH);
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('does not re-arm the clock, so the final game time survives a later push', () => {
    // status is still 'playing', so the "game is running, start the clock"
    // branch re-armed gameActualStartTime to now — and the finished branch a
    // few lines below then recomputed gameTimeInSeconds as now-minus-now = 0
    // and broadcast it, repainting every end screen to 00:00.
    pushState({ roomId, newState: { round: 5 } });

    expect(rooms[roomId].gameActualStartTime).toBeNull();
    expect(rooms[roomId].state.gameTimeInSeconds).toBe(PLAYED_SECONDS);
  });

  it('DOES start a fresh clock when Play Again actually restarts the game', () => {
    // The other side of the !finished guard. A rematch is exactly the push
    // that clears finished, and it must get a new anchor — guarding on status
    // alone was wrong, but guarding too eagerly would leave the next game
    // timing from null and reporting 0.
    pushState({
      roomId,
      newState: {
        status: 'playing', finished: false, currentPlayerIndex: 0, round: 1,
        players: [{ name: 'Alice' }, { name: 'Bob' }],
      },
    });

    expect(rooms[roomId].state.finished).toBe(false);
    expect(rooms[roomId].gameActualStartTime).toBe(LATER_PUSH);
  });

  it('does not zero the clock even when the push is discarded for a stale roster', () => {
    // applyPushedState bails on a roster mismatch, but the clock bookkeeping
    // ran regardless of whether anything was applied — so a Play Again click
    // carrying a roster a departing player had just invalidated still wiped
    // the finished game's duration.
    pushState({ roomId, newState: { players: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }] } });

    expect(rooms[roomId].state.gameTimeInSeconds).toBe(PLAYED_SECONDS);
  });
});
