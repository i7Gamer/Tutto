/**
 * @vitest-environment node
 *
 * In-process suites for the connection-level concerns socketHandlers.ts
 * itself owns: per-event rate limits and the per-IP connection cap. The other
 * suites this file used to hold live next to the modules they exercise —
 * socketHandlers.rooms/stats/reactions/gameClock.test.ts — all built on the
 * same startInProcessServer harness (see socketTestHarness.ts on why
 * in-process rather than a spawned server).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Socket as ClientSocket } from 'socket.io-client';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { startInProcessServer, settle, type InProcessServer } from './socketTestHarness';
import { rooms } from './rooms';

describe('Socket event rate limiting (SERVER-XC-3)', () => {
  let server: InProcessServer;
  let client: ClientSocket;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('drops updateConfig events past the per-connection cap instead of applying every one', async () => {
    client = await server.connectAndJoin('RATE_LIMIT_CONFIG', 'Host', 'dev-ratelimit-1');

    let latestWinningScore: number | undefined;
    client.on('gameState', (state: { winningScore: number }) => {
      latestWinningScore = state.winningScore;
    });

    // updateConfig's cap is 20/second — fire one more than that in immediate
    // succession, each with a distinct winningScore so the applied count is
    // directly observable in the broadcast state. The limiter is a synchronous
    // per-event counter check, so settle()'s short margin proves the drop.
    for (let i = 0; i < 21; i++) {
      client.emit('updateConfig', { roomId: 'RATE_LIMIT_CONFIG', winningScore: 1000 + i });
    }

    await settle();

    // The 21st call (winningScore 1020) must have been dropped by the
    // limiter before ever reaching applyValidatedConfig/emitRoomState.
    expect(latestWinningScore).toBe(1019);

    client.disconnect();
  });

  it('drops reorderPlayers events past the per-connection cap instead of applying every one', async () => {
    client = await server.connectAndJoin('RATE_LIMIT_REORDER', 'Host', 'dev-ratelimit-reorder-1');
    const peer = await server.connectAndJoin('RATE_LIMIT_REORDER', 'Peer', 'dev-ratelimit-reorder-2');

    // The cap is 5/second — fire 6 alternating permutations. Odd emits flip
    // the order, even emits restore it: with exactly 5 applied the roster
    // ends flipped; if the 6th (restoring) call were applied too, it would
    // end in the original order.
    const flipped = [{ name: 'Peer' }, { name: 'Host' }];
    const original = [{ name: 'Host' }, { name: 'Peer' }];
    for (let i = 0; i < 6; i++) {
      client.emit('reorderPlayers', { roomId: 'RATE_LIMIT_REORDER', newPlayers: i % 2 === 0 ? flipped : original });
    }

    await settle();

    expect(rooms['RATE_LIMIT_REORDER'].state.players.map(p => p.name)).toEqual(['Peer', 'Host']);

    peer.disconnect();
  });

  it('drops updatePlayerColor events past the per-connection cap instead of applying every one', async () => {
    client = await server.connectAndJoin('RATE_LIMIT_COLOR', 'Host', 'dev-ratelimit-color-1');

    // The cap is 20/second — fire 21 distinct colors. The 20th (i=19,
    // '#000023') must be the last one applied; the 21st ('#000024') dropped.
    for (let i = 0; i < 21; i++) {
      client.emit('updatePlayerColor', { roomId: 'RATE_LIMIT_COLOR', color: `#0000${(16 + i).toString(16)}` });
    }

    await settle();

    expect(rooms['RATE_LIMIT_COLOR'].state.players[0].color).toBe('#000023');
  });
});

describe('per-IP connection rate limiting', () => {
  let server: InProcessServer;
  let envBefore: string | undefined;

  beforeAll(async () => {
    // Read once inside registerSocketHandlers — must be set BEFORE it runs.
    // Every connection in this suite arrives from 127.0.0.1, i.e. one key.
    envBefore = process.env.SOCKET_CONN_LIMIT_MAX;
    process.env.SOCKET_CONN_LIMIT_MAX = '2';
    server = await startInProcessServer();
  });

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.SOCKET_CONN_LIMIT_MAX;
    else process.env.SOCKET_CONN_LIMIT_MAX = envBefore;
    await server.close();
  });

  it('rejects connections from one address past the cap — reconnecting cannot reset per-connection event limits for free', async () => {
    await server.connect({ reconnection: false });
    await server.connect({ reconnection: false });

    // Third connection in the same window from the same address must be
    // refused at the middleware, before any event handler is registered.
    await expect(server.connect({ reconnection: false })).rejects.toThrow('Too many connections');
  });
});
