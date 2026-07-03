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
