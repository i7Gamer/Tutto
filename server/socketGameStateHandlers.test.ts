/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerGameStateHandlers, MAX_TIMER_RESTARTS_PER_TURN } from './socketGameStateHandlers';
import { rooms, createRoom, deleteRoom } from './rooms';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import type { ServerPlayer } from './roomTypes';

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, emit };
};

type Handler = (...args: unknown[]) => unknown;

const makeFakeSocket = (id: string) => {
  const handlers: Record<string, Handler> = {};
  const socket = {
    id,
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    on: (event: string, fn: Handler) => { handlers[event] = fn; },
  } as unknown as Socket;
  return { socket, handlers };
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
