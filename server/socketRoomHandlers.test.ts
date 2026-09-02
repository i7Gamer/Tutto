/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server } from 'socket.io';
import { registerRoomHandlers } from './socketRoomHandlers';
import { makeFakeSocket, type Handler } from './socketTestHarness';
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

  it('tells the superseded socket it lost the seat, instead of dropping it in silence', async () => {
    // Removing it from the channel is only half the job. The orphan keeps its
    // roomId, myName, isHost and a full roster, and its socket stays healthy —
    // so every event it sends now hits a silent early return (isHost ||
    // isActivePlayer, the seat lookups, endGameStats). The user can open the
    // dice panel, roll, and commit turns into a void while the server's turn
    // timer runs out on the seat they think they are playing.
    vi.mocked(getDeviceStats).mockResolvedValue(null);

    const oldSocket = { leave: vi.fn() };
    const { io, emit } = makeFakeIo({ 'old-sock': oldSocket });
    const first = makeFakeSocket('old-sock');
    registerRoomHandlers({ io, socket: first.socket, session: { roomId: null, username: null } });
    const cb1 = vi.fn();
    first.handlers['joinRoom']({ roomId: 'TAKEOVER-NOTIFY', name: 'Alice', deviceId: 'dev-same' }, cb1);
    await vi.waitFor(() => expect(cb1).toHaveBeenCalled());

    const second = makeFakeSocket('new-sock');
    registerRoomHandlers({ io, socket: second.socket, session: { roomId: null, username: null } });
    const cb2 = vi.fn();
    second.handlers['joinRoom']({ roomId: 'TAKEOVER-NOTIFY', name: 'Alice', deviceId: 'dev-same' }, cb2);
    await vi.waitFor(() => expect(cb2).toHaveBeenCalled());

    // Addressed to the superseded socket specifically, and sent before it is
    // removed from the channel — io.to(id) reaches it either way, but the
    // ordering keeps the two halves of "you are out" together.
    expect(io.to).toHaveBeenCalledWith('old-sock');
    expect(emit).toHaveBeenCalledWith('seatTakenOver');
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

    // The upper caps, not just the empty case. Both ids are stored, echoed
    // and (for roomId) used as a channel name, so an unbounded one is memory
    // a single unauthenticated payload can claim.
    const longRoom = await joinAndWait(handlers, { roomId: 'x'.repeat(101), name: 'Alice', deviceId: 'dev-bad' });
    expect(longRoom).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_room' }));

    const longDevice = await joinAndWait(handlers, { roomId: 'BAD-ROOM', name: 'Alice', deviceId: 'x'.repeat(201) });
    expect(longDevice).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_device' }));

    // The name is trimmed BEFORE it is measured, so whitespace is not a name
    // -- without that, a seat could be taken by a blank label no one can
    // read, refer to or kick.
    const blankName = await joinAndWait(handlers, { roomId: 'BAD-ROOM', name: '   ', deviceId: 'dev-bad' });
    expect(blankName).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_name' }));
  });

  it('seats a padded name under its trimmed form', async () => {
    // The other half of the same trim: it must not merely reject, it has to
    // be what gets stored -- the name is the key every later lookup uses
    // (name_taken, kickPlayer, the roster merge in applyPushedState).
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('padded-name-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    await joinAndWait(handlers, { roomId: 'PADDED-NAME-ROOM', name: '  Alice  ', deviceId: 'dev-padded' });

    expect(rooms['PADDED-NAME-ROOM'].state.players.map(p => p.name)).toEqual(['Alice']);
    deleteRoom('PADDED-NAME-ROOM');
  });

  it('refuses a fresh seat once the game has started', async () => {
    // A room in progress has a fixed roster: a new seat mid-game would take a
    // turn out of an order every client has already computed, and arrive with
    // no score in a race someone is trying to win. Reconnecting to an
    // EXISTING seat is a different path and still allowed.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('game-running-host');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    await joinAndWait(handlers, { roomId: 'GAME-RUNNING-ROOM', name: 'Alice', deviceId: 'dev-gr-a' });
    rooms['GAME-RUNNING-ROOM'].state.status = 'playing';

    const latecomer = makeFakeSocket('game-running-latecomer');
    registerRoomHandlers({ io, socket: latecomer.socket, session: { roomId: null, username: null } });
    const refused = await joinAndWait(latecomer.handlers, {
      roomId: 'GAME-RUNNING-ROOM', name: 'Bob', deviceId: 'dev-gr-b',
    });

    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'game_running' }));
    expect(rooms['GAME-RUNNING-ROOM'].state.players).toHaveLength(1);
    deleteRoom('GAME-RUNNING-ROOM');
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

// A10: a reconnect must never CREATE the room it is trying to rejoin. Rooms
// live only in memory, so a server restart empties `rooms` while clients
// still hold a stale roomId — before this, their automatic rejoin (isReconnect)
// silently created a brand-new, empty lobby under that old code and seated the
// rejoiner as its host, and the next arriving player joined this fresh lobby
// as a normal (non-reconnect) join, which then broadcast a lobby-status
// gameState over their still-"playing" client and fired a false "Host ended
// game early" toast (src/store/socketSlice.ts). Refusing the reconnect
// outright — rather than creating anything — is what starves that false
// toast of the broadcast it needs.
describe('joinRoom: a reconnect must not create the room it targets', () => {
  beforeEach(resetRooms);

  it('refuses a reconnect into a room that no longer exists, and creates nothing', async () => {
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('reconnect-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    const ack = await joinAndWait(handlers, {
      roomId: 'RESTARTED-ROOM', name: 'Alice', deviceId: 'dev-reconnect', isReconnect: true,
    });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'room-gone' }));
    expect(rooms['RESTARTED-ROOM']).toBeUndefined();
  });

  it('still creates the room for a normal (non-reconnect) join into a missing room', async () => {
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('fresh-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    const ack = await joinAndWait(handlers, {
      roomId: 'FRESH-ROOM', name: 'Alice', deviceId: 'dev-fresh',
    });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(rooms['FRESH-ROOM']).toBeDefined();
    expect(rooms['FRESH-ROOM'].state.players).toHaveLength(1);
  });

  it('leaves a reconnect into an EXISTING room unaffected', async () => {
    const { io } = makeFakeIo();
    const host = makeFakeSocket('existing-room-host');
    registerRoomHandlers({ io, socket: host.socket, session: { roomId: null, username: null } });
    await joinAndWait(host.handlers, { roomId: 'STILL-HERE-ROOM', name: 'Alice', deviceId: 'dev-existing' });

    // A new socket standing in for the same device reconnecting (e.g. after a
    // page reload) — the rejoin-by-deviceId path, unaffected by the new guard
    // since the room is still there.
    const rejoin = makeFakeSocket('existing-room-rejoin');
    registerRoomHandlers({ io, socket: rejoin.socket, session: { roomId: null, username: null } });
    const ack = await joinAndWait(rejoin.handlers, {
      roomId: 'STILL-HERE-ROOM', name: 'Alice', deviceId: 'dev-existing', isReconnect: true,
    });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(rooms['STILL-HERE-ROOM'].state.players).toHaveLength(1);
    expect(rooms['STILL-HERE-ROOM'].state.players[0].socketId).toBe('existing-room-rejoin');
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

  it('cancels the pending removal when the player reconnects in time', async () => {
    // Without this clearTimeout the original timer keeps running against a
    // seat that is occupied again, and fires: the player is removed a minute
    // after successfully reconnecting, mid-turn, for no reason they can see.
    // The seat is reused by deviceId, so the timer's key is still live.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('reconnect-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    await joinAndWait(handlers, { roomId: 'RECONNECT-CANCEL-ROOM', name: 'Alice', deviceId: 'dev-rc-a' });
    const peer = makeFakeSocket('peer-rc-sock');
    registerRoomHandlers({ io, socket: peer.socket, session: { roomId: null, username: null } });
    await joinAndWait(peer.handlers, { roomId: 'RECONNECT-CANCEL-ROOM', name: 'Bob', deviceId: 'dev-rc-b' });

    handlers['disconnect']();
    expect(Object.keys(rooms['RECONNECT-CANCEL-ROOM'].disconnectTimers)).toEqual(['dev-rc-a']);

    // Same deviceId from a new connection: the reconnect path.
    const again = makeFakeSocket('reconnect-sock-2');
    registerRoomHandlers({ io, socket: again.socket, session: { roomId: null, username: null } });
    await joinAndWait(again.handlers, { roomId: 'RECONNECT-CANCEL-ROOM', name: 'Alice', deviceId: 'dev-rc-a' });

    const room = rooms['RECONNECT-CANCEL-ROOM'];
    expect(Object.keys(room.disconnectTimers), 'the removal timer is still armed against a seat that came back').toEqual([]);
    expect(room.state.players.find(p => p.name === 'Alice')?.disconnected).toBe(false);
    deleteRoom('RECONNECT-CANCEL-ROOM');
  });

  it('arms no timer at all when the kick timer is disabled', async () => {
    // reconnectTimeout: 0 means "never kick automatically". The regression it
    // guards against is a `|| 60` fallback reading 0 as the default minute.
    //
    // Asserted on the armed timer rather than on a player surviving a wait:
    // the e2e version of this waits 70ms (testDelay(350)) for a kick that,
    // with the bug, would fire 12 SECONDS later -- so it passed either way.
    // There is nothing to wait for here; either the timer exists or it does
    // not.
    const { io } = makeFakeIo();
    const { socket, handlers } = makeFakeSocket('no-timer-sock');
    registerRoomHandlers({ io, socket, session: { roomId: null, username: null } });

    await joinAndWait(handlers, { roomId: 'NO-KICK-TIMER-ROOM', name: 'Alice', deviceId: 'dev-nk-a' });
    // A second seat keeps the room alive, so the disconnect takes the
    // arm-a-timer path rather than tearing the room down.
    const peer = makeFakeSocket('peer-nk-sock');
    registerRoomHandlers({ io, socket: peer.socket, session: { roomId: null, username: null } });
    await joinAndWait(peer.handlers, { roomId: 'NO-KICK-TIMER-ROOM', name: 'Bob', deviceId: 'dev-nk-b' });

    rooms['NO-KICK-TIMER-ROOM'].state.reconnectTimeout = 0;
    handlers['disconnect']();

    const room = rooms['NO-KICK-TIMER-ROOM'];
    expect(Object.keys(room.disconnectTimers), 'a kick timer was armed for a room that disabled them').toEqual([]);
    expect(room.state.players, 'the seat must be kept, not removed').toHaveLength(2);
    expect(room.state.players.find(p => p.name === 'Alice')?.disconnected).toBe(true);
    deleteRoom('NO-KICK-TIMER-ROOM');
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
