/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerRoomHandlers } from './socketRoomHandlers';
import { rooms, deleteRoom } from './rooms';
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
    expect(oldSocket.leave).toHaveBeenCalledWith('TAKEOVER-ROOM');
    expect(rooms['TAKEOVER-ROOM'].state.players[0].socketId).toBe('new-sock');
  });
});
