/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerStatsHandlers } from './socketStatsHandlers';
import { rooms, createRoom, deleteRoom } from './rooms';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import type { ServerPlayer } from './roomTypes';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));
import { getDeviceStats, updateDeviceStats } from './database';

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

const makePlayer = (name: string, socketId: string, deviceId: string): ServerPlayer => ({
  name,
  deviceId,
  socketId,
  score: 0,
  position: 1,
  disconnected: false,
  ...zeroedPlayerStats(),
});

describe('endGameStats win-streak refresh', () => {
  const roomId = 'STREAK-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset();
  });

  it('writes the refreshed streak to the CURRENT seat, not a pre-await snapshot', async () => {
    // Between the two awaits a players-carrying push (e.g. the host's Play
    // Again) can rebuild every roster entry — writing to the object resolved
    // before the awaits would update a detached copy and broadcast the very
    // stale streak this refresh exists to fix.
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    // The interleaved push, simulated at the first await: every roster entry
    // is replaced by a copy.
    vi.mocked(updateDeviceStats).mockImplementation(async () => {
      rooms[roomId].state.players = rooms[roomId].state.players.map(p => ({ ...p }));
      return 1;
    });
    vi.mocked(getDeviceStats).mockResolvedValue({ currentWinStreak: 5 } as never);

    const { io } = makeFakeIo();
    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io, socket: fake.socket, session: { roomId, username: 'Alice' } });

    fake.handlers['endGameStats']({ deviceId: 'dev-alice', stats: { gamesPlayed: 1, wins: 1 } });

    await vi.waitFor(() => expect(getDeviceStats).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(rooms[roomId].state.players[0].winStreak).toBe(5));
  });
});
