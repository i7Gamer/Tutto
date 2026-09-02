/**
 * @vitest-environment node
 *
 * "Is a NON-host refused?" for every host-gated socket event.
 *
 * sockets.authorization.test.ts covers the two events whose authorization is
 * per-push — pushState and liveTurnState — and every other suite drives the
 * four events below from the host, i.e. only ever proves that the host CAN.
 * Deleting all four host checks left the whole 760-test server suite green,
 * so any seated player could rewrite the config, reorder the roster, kick
 * anybody, and submit the game's global statistics with nothing failing.
 *
 * Fake sockets rather than a spawned server: the gate is a single comparison
 * against `room.host`, so a real transport would add seconds per case and
 * prove nothing extra. Each test asserts the refusal AND — separately — that
 * the same call from the host succeeds, so a test can never pass because the
 * event was inert (a typo'd name, a rejected payload, a changed shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server } from 'socket.io';
import { registerConfigHandlers } from './socketConfigHandlers';
import { registerRosterHandlers } from './socketRosterHandlers';
import { registerStatsHandlers } from './socketStatsHandlers';
import { makeFakeSocket, makeServerPlayer, type Handler } from './socketTestHarness';
import { rooms, createRoom, deleteRoom } from './rooms';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(async () => null),
  updateDeviceStats: vi.fn(async () => true),
  updateGlobalStats: vi.fn(async () => 1),
}));
import { updateGlobalStats } from './database';

const HOST_SOCKET = 'sock-host';
const GUEST_SOCKET = 'sock-guest';
const roomId = 'AUTHZ_ROOM';

const makeFakeIo = () => {
  const emit = vi.fn();
  return {
    io: { to: vi.fn(() => ({ emit })), sockets: { sockets: { get: () => undefined } } } as unknown as Server,
    emit,
  };
};

/** Registers every host-gated handler for one socket and returns them by name. */
const handlersFor = (socketId: string): Record<string, Handler> => {
  const fake = makeFakeSocket(socketId);
  const { io } = makeFakeIo();
  const ctx = { io, socket: fake.socket, session: { roomId, username: null } };
  registerConfigHandlers(ctx);
  registerRosterHandlers(ctx);
  registerStatsHandlers(ctx);
  return fake.handlers;
};

describe('host-gated socket events refuse a non-host', () => {
  let host: Record<string, Handler>;
  let guest: Record<string, Handler>;

  beforeEach(() => {
    vi.mocked(updateGlobalStats).mockClear();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom(HOST_SOCKET);
    Object.assign(rooms[roomId].state, {
      status: 'lobby',
      players: [
        makeServerPlayer('Alice', { socketId: HOST_SOCKET }),
        makeServerPlayer('Bob', { socketId: GUEST_SOCKET }),
      ],
      winningScore: 6000,
      randomOrder: true,
    });
    host = handlersFor(HOST_SOCKET);
    guest = handlersFor(GUEST_SOCKET);
  });

  it('updateConfig: a seated non-host cannot change the winning score', () => {
    guest.updateConfig({ roomId, winningScore: 1000 });
    expect(rooms[roomId].state.winningScore, 'the guest must not rewrite the room config').toBe(6000);

    // The control: the identical call from the host lands, so the refusal
    // above cannot be an inert event or a rejected payload.
    host.updateConfig({ roomId, winningScore: 1000 });
    expect(rooms[roomId].state.winningScore).toBe(1000);
  });

  it('reorderPlayers: a seated non-host cannot reorder the turn order', () => {
    const reversed = [{ name: 'Bob' }, { name: 'Alice' }];

    guest.reorderPlayers({ roomId, newPlayers: reversed });
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);

    host.reorderPlayers({ roomId, newPlayers: reversed });
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Bob', 'Alice']);
  });

  it('kickPlayer: a seated non-host cannot kick anybody', () => {
    guest.kickPlayer(HOST_SOCKET);
    expect(rooms[roomId].state.players.map(p => p.name), 'the guest must not kick the host').toEqual(['Alice', 'Bob']);

    host.kickPlayer(GUEST_SOCKET);
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Alice']);
  });

  it('submitGlobalStats: a seated non-host cannot record the game', async () => {
    rooms[roomId].state.finished = true;

    await guest.submitGlobalStats({ roomId, payload: { gamesPlayed: 1, isDefaultGame: true } });
    expect(updateGlobalStats, 'the guest must not write the global row').not.toHaveBeenCalled();
    expect(rooms[roomId].statsRecordedForGame.global).toBe(false);

    await host.submitGlobalStats({ roomId, payload: { gamesPlayed: 1, isDefaultGame: true } });
    expect(updateGlobalStats).toHaveBeenCalledTimes(1);
  });
});
