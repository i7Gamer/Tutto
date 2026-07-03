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

describe('kickPlayer host migration', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

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

  const connectAndJoin = (roomId: string, name: string, deviceId: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: { success: boolean; error?: string }) => {
          if (!res.success) return reject(new Error(res.error));
          resolve(sock);
        });
      });
      sock.on('connect_error', reject);
    });

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
});
