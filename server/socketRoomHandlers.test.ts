/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerRoomHandlers } from './socketRoomHandlers';
import { rooms, deleteRoom, roomChannel } from './rooms';
import type { ConnectionSession } from './socketContext';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
}));
import { getDeviceStats } from './database';

const makeFakeIo = (knownSockets: Record<string, { leave: ReturnType<typeof vi.fn> }> = {}) => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const io = {
    to,
    sockets: { sockets: { get: (id: string) => knownSockets[id] } },
  } as unknown as Server;
  return { io, emit };
};

type Handler = (...args: unknown[]) => unknown;

// A minimal socket double: registerRoomHandlers wires its listeners through
// safeOn (which wraps and swallows the returned promise), so tests capture the
// wrapped handlers off `on` and invoke them directly.
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

describe('joinRoom vs a disconnect during its stats await', () => {
  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
  });

  it('does not seat a socket that disconnected while the stats fetch was in flight', async () => {
    // The stats fetch is the handler's only await — the one window in which
    // the socket's 'disconnect' can interleave. A fresh join has no
    // session.roomId yet, so that disconnect cleans up nothing; without the
    // connected re-check the resumed handler would create a room around a
    // dead socket, marked connected forever, that no event can ever remove.
    const releases: Array<() => void> = [];
    vi.mocked(getDeviceStats).mockImplementation(() =>
      new Promise(resolve => { releases.push(() => resolve(null)); }));

    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('dead-socket');
    const session: ConnectionSession = { roomId: null, username: null };
    registerRoomHandlers({ io, socket, session });

    const callback = vi.fn();
    handlers['joinRoom']({ roomId: 'GHOST-ROOM', name: 'Alice', deviceId: 'dev-ghost' }, callback);

    // The disconnect lands while the handler is parked on the await…
    (socket as unknown as { connected: boolean }).connected = false;
    releases.forEach(release => release());

    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    // …and no ghost room exists afterwards.
    expect(rooms['GHOST-ROOM']).toBeUndefined();
  });

  it('still seats a socket that stayed connected across the await', async () => {
    vi.mocked(getDeviceStats).mockResolvedValue(null);

    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('alive-socket');
    const session: ConnectionSession = { roomId: null, username: null };
    registerRoomHandlers({ io, socket, session });

    const callback = vi.fn();
    handlers['joinRoom']({ roomId: 'LIVE-ROOM', name: 'Alice', deviceId: 'dev-live' }, callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(rooms['LIVE-ROOM']).toBeDefined();
    expect(rooms['LIVE-ROOM'].state.players).toHaveLength(1);
    expect(rooms['LIVE-ROOM'].state.players[0].disconnected).toBe(false);
  });

  it('a same-device takeover removes the superseded socket from the Socket.IO room', async () => {
    // The old, still-connected tab must stop receiving broadcasts (the same
    // .leave() kickPlayer performs) — otherwise it streams the room forever,
    // and if this roomId is later deleted and reused by strangers it would
    // silently receive THEIR room state too.
    vi.mocked(getDeviceStats).mockResolvedValue(null);

    const oldSocket = { leave: vi.fn() };
    const { io } = makeFakeIo({ 'old-sock': oldSocket });
    const first = makeFakeSocket('old-sock');
    registerRoomHandlers({ io, socket: first.socket, session: { roomId: null, username: null } });
    const cb1 = vi.fn();
    first.handlers['joinRoom']({ roomId: 'TAKEOVER-ROOM', name: 'Alice', deviceId: 'dev-same' }, cb1);
    await vi.waitFor(() => expect(cb1).toHaveBeenCalled());

    const second = makeFakeSocket('new-sock');
    registerRoomHandlers({ io, socket: second.socket, session: { roomId: null, username: null } });
    const cb2 = vi.fn();
    second.handlers['joinRoom']({ roomId: 'TAKEOVER-ROOM', name: 'Alice', deviceId: 'dev-same' }, cb2);
    await vi.waitFor(() => expect(cb2).toHaveBeenCalled());

    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // The namespaced channel, never the bare roomId — see roomChannel().
    expect(oldSocket.leave).toHaveBeenCalledWith(roomChannel('TAKEOVER-ROOM'));
    expect(rooms['TAKEOVER-ROOM'].state.players[0].socketId).toBe('new-sock');
  });
});

// Emits a join and resolves once its ack fires — a handler that never acks
// (the failure mode of the prototype-named ids below) fails here rather than
// silently letting the assertions run against a callback nobody called.
const joinAndWait = async (
  handlers: Record<string, Handler>,
  payload: Record<string, unknown>,
) => {
  const callback = vi.fn();
  handlers['joinRoom'](payload, callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalled());
  return callback;
};

const resetRooms = () => {
  for (const id of Object.keys(rooms)) deleteRoom(id);
  vi.mocked(getDeviceStats).mockReset();
  vi.mocked(getDeviceStats).mockResolvedValue(null);
};

describe('joinRoom: one seat per socket', () => {
  beforeEach(resetRooms);

  it('refuses a second seat in the same room for a socket that already holds one', async () => {
    // The one-room-per-DEVICE rule excludes this room, and the rejoin path
    // matches by deviceId — so a scripted client emitting joinRoom twice for
    // the same room under two deviceIds used to get two seats sharing one
    // socket.id. Host migration and the leave/cleanup bookkeeping both assume
    // one seat per socket, so that room could never be re-hosted or deleted.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('greedy-sock');
    const session: ConnectionSession = { roomId: null, username: null };
    registerRoomHandlers({ io, socket, session });

    await joinAndWait(handlers, { roomId: 'TWO-SEATS', name: 'Alice', deviceId: 'dev-first' });
    const second = await joinAndWait(handlers, { roomId: 'TWO-SEATS', name: 'Mallory', deviceId: 'dev-second' });

    expect(second).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(rooms['TWO-SEATS'].state.players).toHaveLength(1);
    expect(rooms['TWO-SEATS'].state.players[0].deviceId).toBe('dev-first');
  });

  it('still lets a socket rejoin the seat it already holds', async () => {
    // The idempotent rejoin (a reconnect, or a lobby rename) matches this
    // socket's OWN seat by deviceId — the refusal above must not catch it.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('same-sock');
    const session: ConnectionSession = { roomId: null, username: null };
    registerRoomHandlers({ io, socket, session });

    await joinAndWait(handlers, { roomId: 'REJOIN-ROOM', name: 'Alice', deviceId: 'dev-same' });
    const second = await joinAndWait(handlers, { roomId: 'REJOIN-ROOM', name: 'Alicia', deviceId: 'dev-same' });

    expect(second).toHaveBeenCalledWith(expect.objectContaining({ success: true, name: 'Alicia' }));
    expect(rooms['REJOIN-ROOM'].state.players).toHaveLength(1);
  });

  it('refuses taking over another seat while this socket still occupies one', async () => {
    // The takeover branch would move this socket onto Bob's seat and leave its
    // own behind, still carrying this socket.id — two seats, one socket, by
    // the other route into the same corruption.
    const { io } = makeFakeIo();
    const bob = makeFakeSocket('bob-sock');
    registerRoomHandlers({ io, socket: bob.socket, session: { roomId: null, username: null } });
    await joinAndWait(bob.handlers, { roomId: 'STEAL-ROOM', name: 'Bob', deviceId: 'dev-bob' });

    const alice = makeFakeSocket('alice-sock');
    registerRoomHandlers({ io, socket: alice.socket, session: { roomId: null, username: null } });
    await joinAndWait(alice.handlers, { roomId: 'STEAL-ROOM', name: 'Alice', deviceId: 'dev-alice' });

    const steal = await joinAndWait(alice.handlers, { roomId: 'STEAL-ROOM', name: 'Bob', deviceId: 'dev-bob' });

    expect(steal).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(rooms['STEAL-ROOM'].state.players.map(p => p.socketId)).toEqual(['bob-sock', 'alice-sock']);
  });

  it('lets a fresh socket take over an existing seat, since it holds none itself', async () => {
    const { io } = makeFakeIo();
    const first = makeFakeSocket('first-sock');
    registerRoomHandlers({ io, socket: first.socket, session: { roomId: null, username: null } });
    await joinAndWait(first.handlers, { roomId: 'HANDOVER-ROOM', name: 'Alice', deviceId: 'dev-handover' });

    const second = makeFakeSocket('second-sock');
    registerRoomHandlers({ io, socket: second.socket, session: { roomId: null, username: null } });
    const ack = await joinAndWait(second.handlers, { roomId: 'HANDOVER-ROOM', name: 'Alice', deviceId: 'dev-handover' });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(rooms['HANDOVER-ROOM'].state.players.map(p => p.socketId)).toEqual(['second-sock']);
  });
});

describe('joinRoom refusals carry a machine code', () => {
  // The prose is built here, in English, and the lobby used to render it raw —
  // a German UI got an English sentence. The code is the part the client can
  // translate; `error` stays put so anything already reading it keeps working.
  beforeEach(resetRooms);

  it('names the reason a fresh join was refused for a taken name', async () => {
    const { io } = makeFakeIo();
    const alice = makeFakeSocket('code-alice');
    registerRoomHandlers({ io, socket: alice.socket, session: { roomId: null, username: null } });
    await joinAndWait(alice.handlers, { roomId: 'CODE-ROOM', name: 'Alice', deviceId: 'dev-code-a' });

    const bob = makeFakeSocket('code-bob');
    registerRoomHandlers({ io, socket: bob.socket, session: { roomId: null, username: null } });
    const ack = await joinAndWait(bob.handlers, { roomId: 'CODE-ROOM', name: 'alice', deviceId: 'dev-code-b' });

    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: 'name_taken',
      error: 'Username already exists in this room',
    });
  });

  it('names the reason a rejoining device was refused a rename', async () => {
    const { io } = makeFakeIo();
    const alice = makeFakeSocket('rename-alice');
    registerRoomHandlers({ io, socket: alice.socket, session: { roomId: null, username: null } });
    await joinAndWait(alice.handlers, { roomId: 'RENAME-CODE-ROOM', name: 'Alice', deviceId: 'dev-rename-a' });

    const bob = makeFakeSocket('rename-bob');
    registerRoomHandlers({ io, socket: bob.socket, session: { roomId: null, username: null } });
    await joinAndWait(bob.handlers, { roomId: 'RENAME-CODE-ROOM', name: 'Bob', deviceId: 'dev-rename-b' });

    const ack = await joinAndWait(bob.handlers, { roomId: 'RENAME-CODE-ROOM', name: 'Alice', deviceId: 'dev-rename-b' });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'name_taken' }));
  });

  it('names the reason for the payload-level refusals too', async () => {
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('bad-payload-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    const noPayload = await joinAndWait(handlers, undefined as unknown as Record<string, unknown>);
    expect(noPayload).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_payload' }));

    const badRoom = await joinAndWait(handlers, { roomId: '', name: 'Alice', deviceId: 'dev-bad' });
    expect(badRoom).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_room' }));

    const badDevice = await joinAndWait(handlers, { roomId: 'BAD-ROOM', name: 'Alice', deviceId: '' });
    expect(badDevice).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_device' }));

    const badName = await joinAndWait(handlers, { roomId: 'BAD-ROOM', name: 'x'.repeat(31), deviceId: 'dev-bad' });
    expect(badName).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_name' }));
  });

  it('names the reason a second seat in the same room was refused', async () => {
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('code-greedy-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    await joinAndWait(handlers, { roomId: 'CODE-TWO-SEATS', name: 'Alice', deviceId: 'dev-code-first' });
    const ack = await joinAndWait(handlers, { roomId: 'CODE-TWO-SEATS', name: 'Mallory', deviceId: 'dev-code-second' });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'already_seated' }));
  });

  it('names the reason a device already seated elsewhere was refused', async () => {
    const { io } = makeFakeIo();
    const first = makeFakeSocket('other-room-sock');
    registerRoomHandlers({ io, socket: first.socket, session: { roomId: null, username: null } });
    await joinAndWait(first.handlers, { roomId: 'CODE-ROOM-A', name: 'Alice', deviceId: 'dev-two-rooms' });

    // A second socket, so the one-socket-one-room rule above does not vacate
    // the first seat before the per-device rule is reached.
    const second = makeFakeSocket('other-room-sock-2');
    registerRoomHandlers({ io, socket: second.socket, session: { roomId: null, username: null } });
    const ack = await joinAndWait(second.handlers, { roomId: 'CODE-ROOM-B', name: 'Alice', deviceId: 'dev-two-rooms' });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'device_in_other_room' }));
  });
});

describe('joinRoom with ids that name Object.prototype members', () => {
  beforeEach(resetRooms);

  it('seats a join whose roomId is one, instead of leaving the ack hanging', async () => {
    // roomId is validated only as a non-empty string within a length bound, so
    // '__proto__' reaches the registry lookup. On a plain object literal
    // `!rooms['__proto__']` is false (Object.prototype is truthy), so no room
    // is created and reading room.state.players off the inherited value throws
    // — safeOn contains the throw, and the caller simply never hears back.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('proto-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    const ack = await joinAndWait(handlers, { roomId: '__proto__', name: 'Alice', deviceId: 'dev-proto' });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(rooms['__proto__'].state.players.map(p => p.name)).toEqual(['Alice']);
  });

  it('arms a cancellable reconnect timer for a deviceId that is one', async () => {
    // The timer is stored under the deviceId. Assigned to a plain object under
    // '__proto__' it became the object's prototype: invisible to the
    // Object.keys/values that cancel it, so deleteRoom could not stop it and
    // the "no pending timers" cleanup check saw a room with none.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('proto-dev-sock');
    const session: ConnectionSession = { roomId: null, username: null };
    registerRoomHandlers({ io, socket, session });

    await joinAndWait(handlers, { roomId: 'PROTO-DEVICE-ROOM', name: 'Alice', deviceId: '__proto__' });
    // A second seat keeps the room alive so the disconnect arms a timer rather
    // than tearing everything down.
    const peer = makeFakeSocket('peer-sock');
    registerRoomHandlers({ io, socket: peer.socket, session: { roomId: null, username: null } });
    await joinAndWait(peer.handlers, { roomId: 'PROTO-DEVICE-ROOM', name: 'Bob', deviceId: 'dev-peer' });

    handlers['disconnect']();

    const room = rooms['PROTO-DEVICE-ROOM'];
    expect(Object.keys(room.disconnectTimers)).toEqual(['__proto__']);
    deleteRoom('PROTO-DEVICE-ROOM');
  });
});
