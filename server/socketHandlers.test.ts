/**
 * @vitest-environment node
 *
 * In-process socketHandlers tests with a mocked database module. Unlike the
 * E2E suites (which spawn the real server as a subprocess), this runs the
 * handlers inside the test process, so DB failures can be injected — the only
 * way to exercise the stats-dedup rollback paths — and the handler code shows
 * up in coverage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));

import { updateDeviceStats, updateGlobalStats } from './database';
import { registerSocketHandlers } from './socketHandlers';
import { rooms } from './rooms';

const mockedUpdateDeviceStats = vi.mocked(updateDeviceStats);
const mockedUpdateGlobalStats = vi.mocked(updateGlobalStats);

describe('stats dedup rollback on DB failure', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  let client: ClientSocket;

  beforeAll(async () => {
    // The rollback paths log the injected failures — keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (client) client.disconnect();
    await ioServer.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateGlobalStats.mockReset();
  });

  const connectAndJoin = (roomId: string, name: string, deviceId: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: { success: boolean; error?: string }) => {
          if (!res.success) return reject(new Error(res.error));
          resolve(sock);
        });
      });
      sock.on('connect_error', reject);
    });

  const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise(r => setTimeout(r, 25));
    }
  };

  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 300));

  it('endGameStats: a failed DB write rolls back the dedup marker so a retry lands, then dedups for real', async () => {
    mockedUpdateDeviceStats.mockRejectedValueOnce(new Error('db down'));
    mockedUpdateDeviceStats.mockResolvedValue(true);

    client = await connectAndJoin('STATS_RETRY_DEV', 'Alice', 'dev-retry-1');

    // First attempt: DB write fails — the dedup marker must be rolled back.
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);

    // Retry: must NOT be swallowed by the dedup (marker was rolled back).
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 2);

    // After a SUCCESSFUL write, a further submit for the same game is deduped.
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateDeviceStats.mock.calls.length).toBe(2);

    client.disconnect();
  });

  it('submitGlobalStats: a failed DB write rolls back the dedup flag so a retry lands, then dedups for real', async () => {
    mockedUpdateGlobalStats.mockRejectedValueOnce(new Error('db down'));
    mockedUpdateGlobalStats.mockResolvedValue(1);

    // First join creates the room with this socket as host — required for
    // submitGlobalStats to be accepted.
    client = await connectAndJoin('STATS_RETRY_GLOBAL', 'Alice', 'dev-retry-2');

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 1);

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 2);

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateGlobalStats.mock.calls.length).toBe(2);

    client.disconnect();
  });
});

describe('room membership (kick host migration, mid-game rename guard)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  interface JoinAck { success: boolean; error?: string; name?: string; isHost?: boolean }

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    sockets.forEach(s => s.disconnect());
    await ioServer.close();
  });

  // Resolves with both the socket and the raw ack so tests can assert on
  // rejections and the seated name, not just successful joins.
  const joinRaw = (roomId: string, name: string, deviceId: string): Promise<{ sock: ClientSocket; res: JoinAck }> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => {
          resolve({ sock, res });
        });
      });
      sock.on('connect_error', reject);
    });

  const connectAndJoin = async (roomId: string, name: string, deviceId: string): Promise<ClientSocket> => {
    const { sock, res } = await joinRaw(roomId, name, deviceId);
    if (!res.success) throw new Error(res.error);
    return sock;
  };

  it('reassigns the host when the host kicks their own socket', async () => {
    // Only a modified host client can self-kick, but the room must not be
    // left with a host id that is no longer seated — no config, kick or
    // restart would work for anyone until the room died.
    const host = await connectAndJoin('SELF_KICK_ROOM', 'Host', 'dev-sk-h');
    const peer = await connectAndJoin('SELF_KICK_ROOM', 'Peer', 'dev-sk-p');

    const hostKicked = new Promise<void>(resolve => host.on('kicked', () => resolve()));
    const peerBecomesHost = new Promise<string>(resolve =>
      peer.on('hostId', (id: string) => { if (id === peer.id) resolve(id); })
    );

    host.emit('kickPlayer', host.id);

    await hostKicked;
    expect(await peerBecomesHost).toBe(peer.id);
    expect(rooms['SELF_KICK_ROOM'].host).toBe(peer.id);
    expect(rooms['SELF_KICK_ROOM'].state.players.map(p => p.name)).toEqual(['Peer']);
  });

  it('kicking a non-host player leaves the host unchanged', async () => {
    const host = await connectAndJoin('NORMAL_KICK_ROOM', 'Host', 'dev-nk-h');
    const peer = await connectAndJoin('NORMAL_KICK_ROOM', 'Peer', 'dev-nk-p');

    const peerKicked = new Promise<void>(resolve => peer.on('kicked', () => resolve()));
    host.emit('kickPlayer', peer.id);
    await peerKicked;

    expect(rooms['NORMAL_KICK_ROOM'].host).toBe(host.id);
    expect(rooms['NORMAL_KICK_ROOM'].state.players.map(p => p.name)).toEqual(['Host']);
  });

  it('a mid-game rejoin with a different name keeps the seat name and returns it in the ack', async () => {
    // Names are the identity key for pushState merging and the chart series —
    // renaming mid-game corrupted both, so the server refuses it and tells the
    // client which name it was actually seated under.
    const host = await connectAndJoin('RENAME_GAME_ROOM', 'Alice', 'dev-rn-1');
    host.emit('pushState', { roomId: 'RENAME_GAME_ROOM', newState: { status: 'playing', currentPlayerIndex: 0 } });
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (rooms['RENAME_GAME_ROOM']?.state.status === 'playing') return resolve();
        if (Date.now() - start > 3000) return reject(new Error('room never started playing'));
        setTimeout(poll, 25);
      };
      poll();
    });

    // Same device takes over its seat from a new socket, but with a new name.
    const { res } = await joinRaw('RENAME_GAME_ROOM', 'Impostor', 'dev-rn-1');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Alice');
    expect(rooms['RENAME_GAME_ROOM'].state.players.map(p => p.name)).toEqual(['Alice']);
  });

  it('a lobby rejoin may still rename freely', async () => {
    await connectAndJoin('RENAME_LOBBY_ROOM', 'Bob', 'dev-rn-2');

    const { res } = await joinRaw('RENAME_LOBBY_ROOM', 'Bobby', 'dev-rn-2');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Bobby');
    expect(rooms['RENAME_LOBBY_ROOM'].state.players.map(p => p.name)).toEqual(['Bobby']);
  });

  it('a lobby rename to a name held by another player is still rejected', async () => {
    await connectAndJoin('RENAME_CONFLICT_ROOM', 'Carol', 'dev-rn-3');
    await connectAndJoin('RENAME_CONFLICT_ROOM', 'Dave', 'dev-rn-4');

    const { res } = await joinRaw('RENAME_CONFLICT_ROOM', 'carol', 'dev-rn-4');

    expect(res.success).toBe(false);
    expect(res.error).toBe('Username already exists in this room');
    expect(rooms['RENAME_CONFLICT_ROOM'].state.players.map(p => p.name).sort()).toEqual(['Carol', 'Dave']);
  });
});
