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

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, emit };
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
});
