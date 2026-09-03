/**
 * @vitest-environment node
 *
 * In-process unit tests for the roster handlers, driven through makeFakeSocket
 * with no network at all. The spawned socket suites cover the same events end
 * to end; these pin the two gates that have no client able to exercise them —
 * a colour change against a running game, and a kick that leaves the room with
 * nobody connected to hand it to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'socket.io';
import { registerRosterHandlers } from './socketRosterHandlers';
import { makeFakeSocket, makeServerPlayer } from './socketTestHarness';
import { rooms, createRoom, deleteRoom } from './rooms';

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const io = {
    to,
    sockets: { sockets: { get: () => undefined } },
  } as unknown as Server;
  return { io, emit };
};

const seat = (roomId: string, socketId: string, username: string) => {
  const fake = makeFakeSocket(socketId);
  const { io, emit } = makeFakeIo();
  registerRosterHandlers({ io, socket: fake.socket, session: { roomId, username } });
  return { handlers: fake.handlers, emit };
};

const gameStates = (emit: ReturnType<typeof vi.fn>) =>
  emit.mock.calls.filter(([event]) => event === 'gameState');

describe('updatePlayerColor is a lobby control', () => {
  const roomId = 'COLOR-GATE-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].state.players = [
      makeServerPlayer('Alice', { socketId: 'alice-sock' }),
      makeServerPlayer('Bob', { socketId: 'bob-sock' }),
    ];
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('refuses a colour change once the game is running', () => {
    // The only production caller is the lobby colour picker (gameSlice.ts).
    // Ungated, this was a free re-broadcast of the whole room state at the
    // limiter's 20/s from any seat — and it repainted a player's colour under
    // a game whose historyLog entries already carry the old one.
    Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: 0 });
    const alice = seat(roomId, 'alice-sock', 'Alice');

    alice.handlers['updatePlayerColor']({ roomId, color: '#123456' });

    expect(rooms[roomId].state.players[0].color).toBe('#ff0000');
    expect(gameStates(alice.emit), 'a refused colour change still re-broadcast the room').toHaveLength(0);
  });

  it('still applies it in the lobby, which is the whole point of the event', () => {
    const alice = seat(roomId, 'alice-sock', 'Alice');

    alice.handlers['updatePlayerColor']({ roomId, color: '#123456' });

    expect(rooms[roomId].state.players[0].color).toBe('#123456');
    expect(gameStates(alice.emit)).toHaveLength(1);
  });
});

describe('kickPlayer never leaves the room owned by a disconnected seat', () => {
  const roomId = 'KICK-HOST-ROOM';

  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('alice-sock');
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('leaves the room unclaimed rather than handing it to a ghost', () => {
    // Only a modified host client can kick its own socket, but the fallback it
    // reached — `?? room.state.players[0]` — then pinned the room on whichever
    // ghost happened to sit first. That is worse than leaving it unclaimed:
    // the room is unmanageable either way, but the first player to reconnect
    // can only pick it up (joinRoom's repair) while nothing seated is holding
    // it, and here that would have been the wrong ghost.
    const room = rooms[roomId];
    room.state.players = [
      makeServerPlayer('Alice', { socketId: 'alice-sock' }),
      makeServerPlayer('Bob', { socketId: 'bob-sock', disconnected: true }),
      makeServerPlayer('Carol', { socketId: 'carol-sock', disconnected: true }),
    ];
    // Pending windows for both ghosts, so the room is legitimately held open
    // (isAbandonedRoom) instead of being torn down by the kick.
    room.disconnectTimers['dev-Bob'] = setTimeout(() => {}, 600_000);
    room.disconnectTimers['dev-Carol'] = setTimeout(() => {}, 600_000);

    const alice = seat(roomId, 'alice-sock', 'Alice');
    alice.handlers['kickPlayer']('alice-sock');

    expect(rooms[roomId], 'the room was torn down instead of held open').toBeDefined();
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Bob', 'Carol']);
    expect(
      rooms[roomId].state.players.find(p => p.socketId === rooms[roomId].host)?.disconnected,
      'the room was handed to a socket that is not there',
    ).not.toBe(true);
  });

  it('still promotes a connected seat when the kick leaves one', () => {
    // The control: without it the assertion above would also hold for a
    // handler that never reassigns the host at all.
    const room = rooms[roomId];
    room.state.players = [
      makeServerPlayer('Alice', { socketId: 'alice-sock' }),
      makeServerPlayer('Bob', { socketId: 'bob-sock', disconnected: true }),
      makeServerPlayer('Carol', { socketId: 'carol-sock' }),
    ];
    room.disconnectTimers['dev-Bob'] = setTimeout(() => {}, 600_000);

    const alice = seat(roomId, 'alice-sock', 'Alice');
    alice.handlers['kickPlayer']('alice-sock');

    expect(rooms[roomId].host).toBe('carol-sock');
  });
});
