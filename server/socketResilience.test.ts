/**
 * @vitest-environment node
 *
 * Containment tests for the socket layer: a handler that blows up must cost
 * one EVENT, not the whole process.
 *
 * Both escape routes are fatal in production. socket.io dispatches listeners
 * from a bare `process.nextTick` (see its Socket#dispatch), so a synchronous
 * throw is an uncaught exception with no caller to catch it — and index.ts
 * installs no uncaughtException handler. The async handlers return promises
 * nobody awaits, so a throw there becomes an unhandled rejection — which
 * index.ts deliberately turns into `process.exit(1)`. Either way one malformed
 * event from one client takes down every room and every player.
 *
 * These run in-process (rather than against a spawned server like the
 * sockets.*.test.ts suites) because the failures have to be INJECTED: after
 * the input-validation fixes there is no longer a real payload that makes a
 * handler throw, and the point here is the structural net, not any one bug.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';

// Toggled per test to make a specific rooms.ts call blow up. Hoisted so the
// vi.mock factory below (which vitest lifts above the imports) can close over it.
const failures = vi.hoisted(() => ({
  emitRoomState: false,
  handleActivePlayerRemoved: false,
}));

vi.mock('./rooms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rooms')>();
  return {
    ...actual,
    emitRoomState: (...args: Parameters<typeof actual.emitRoomState>) => {
      if (failures.emitRoomState) throw new Error('injected emitRoomState failure');
      return actual.emitRoomState(...args);
    },
    handleActivePlayerRemoved: (...args: Parameters<typeof actual.handleActivePlayerRemoved>) => {
      if (failures.handleActivePlayerRemoved) throw new Error('injected handleActivePlayerRemoved failure');
      return actual.handleActivePlayerRemoved(...args);
    },
  };
});

import { registerSocketHandlers } from './socketHandlers';
import { rooms, deleteRoom } from './rooms';

describe('socket handler failure containment', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const openClients: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await ioServer.close();
    httpServer.close();
  });

  beforeEach(() => {
    failures.emitRoomState = false;
    failures.handleActivePlayerRemoved = false;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    openClients.splice(0).forEach(c => c.disconnect());
    Object.keys(rooms).forEach(deleteRoom);
    vi.restoreAllMocks();
  });

  const connect = async (): Promise<ClientSocket> => {
    const client = clientIo(`http://127.0.0.1:${port}`);
    openClients.push(client);
    await new Promise<void>(resolve => client.on('connect', () => resolve()));
    return client;
  };

  const join = (client: ClientSocket, roomId: string, name: string, deviceId: string): Promise<void> =>
    new Promise(resolve => client.emit('joinRoom', { roomId, name, deviceId }, () => resolve()));

  // Proof the server is still serving: a plain event still produces a broadcast.
  const expectStillServing = async (client: ClientSocket, roomId: string): Promise<void> => {
    const broadcast = new Promise<string>(resolve => {
      client.on('gameState', (state: { players?: { color: string }[] }) => {
        if (state.players?.[0]?.color === '#123456') resolve(state.players[0].color);
      });
    });
    client.emit('updatePlayerColor', { roomId, color: '#123456' });
    await expect(broadcast).resolves.toBe('#123456');
  };

  it('contains a synchronous throw from a listener', async () => {
    const client = await connect();
    await join(client, 'SYNC_THROW', 'Alice', 'dev-sync-throw');

    failures.emitRoomState = true;
    client.emit('updatePlayerColor', { roomId: 'SYNC_THROW', color: '#abcdef' });
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[socket:updatePlayerColor]'),
      expect.any(Error),
    ));

    failures.emitRoomState = false;
    await expectStillServing(client, 'SYNC_THROW');
  }, 10000);

  it('contains a rejected promise from an async listener', async () => {
    // joinRoom acks BEFORE its emitRoomState, so the client still sees success;
    // the rejection escapes afterwards, out of the handler nobody awaits.
    const client = await connect();

    failures.emitRoomState = true;
    await join(client, 'ASYNC_THROW', 'Alice', 'dev-async-throw');
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[socket:joinRoom]'),
      expect.any(Error),
    ));

    failures.emitRoomState = false;
    await expectStillServing(client, 'ASYNC_THROW');
  }, 10000);

  it('contains a throw from the reconnect-timeout timer callback', async () => {
    // Same hazard advanceTurnOnTimeout already guards against and cites in its
    // own comment: a bare setTimeout callback has no caller to catch a throw.
    const host = await connect();
    const peer = await connect();
    await join(host, 'TIMER_THROW', 'Alice', 'dev-timer-throw-a');
    await join(peer, 'TIMER_THROW', 'Bob', 'dev-timer-throw-b');

    // Fire the reconnect timeout almost immediately (the handler floors it at
    // 10ms) instead of waiting out the 60s default.
    rooms['TIMER_THROW'].state.reconnectTimeout = 0.05;

    failures.handleActivePlayerRemoved = true;
    peer.disconnect();
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[disconnectTimer]'),
      expect.any(Error),
    ));

    failures.handleActivePlayerRemoved = false;
    expect(rooms['TIMER_THROW']).toBeDefined();
    await expectStillServing(host, 'TIMER_THROW');
  }, 10000);
});
