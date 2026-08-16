/**
 * @vitest-environment node
 *
 * In-process socket suite for the server-authoritative game clock
 * (gameTimeInSeconds / gameActualStartTime, computed in rooms.ts and applied
 * on the pushState path). Split out of socketHandlers.test.ts along the
 * handler-module lines; the database module is mocked (see
 * socketTestHarness.ts on why in-process).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { startInProcessServer, emitJoin, type InProcessServer } from './socketTestHarness';
import { rooms } from './rooms';

describe('game clock (gameTimeInSeconds / gameActualStartTime)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  // These tests exercise the real socket wire path (join → pushState →
  // server-computed elapsed time → broadcast), so the server's Date.now()
  // calls must stay real. Rather than sleeping real wall-clock seconds to
  // cross the 1-second floor in calculateGameTime (rooms.ts), we backdate the
  // room's own gameActualStartTime anchor — the same technique rooms.test.ts
  // already uses for the lower-level unit tests. This is preferable to
  // globally faking Date (vi.useFakeTimers) because it can't perturb
  // socket.io/engine.io's own internal timestamp bookkeeping.
  const backdateClock = (roomId: string, ms: number): void => {
    rooms[roomId].gameActualStartTime = Date.now() - ms;
  };

  it('is server-calculated and increases monotonically across pushState calls', async () => {
    const roomId = 'GAME_TIME_MONOTONIC';
    const s1 = await server.connectAndJoin(roomId, 'Alice', 'dev-gtm-a');

    const firstPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s1.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '200', cards: [], currentPlayerIndex: 0, round: 1,
        finished: false, gameTimeInSeconds: 999, // stale/wrong — server must override
        players: [{ name: 'Alice', deviceId: 'dev-gtm-a', score: 0 }],
      },
    });
    const first = await firstPlaying;
    expect(first.gameTimeInSeconds).toBeLessThan(5);

    backdateClock(roomId, 2000);

    const secondPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => s1.once('gameState', resolve));
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '300', cards: [], currentPlayerIndex: 0, round: 1,
        finished: false, gameTimeInSeconds: 999, // still stale — server must still override
        players: [{ name: 'Alice', deviceId: 'dev-gtm-a', score: 0 }],
      },
    });
    const second = await secondPlaying;
    expect(second.gameTimeInSeconds).toBeLessThan(5);
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(2);
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(first.gameTimeInSeconds);
  });

  it('on game-end is the server-calculated elapsed time, not the stale client-pushed value', async () => {
    const roomId = 'GAME_TIME_END_SNAPSHOT';
    const s1 = await server.connectAndJoin(roomId, 'Alice', 'dev-gtes-a');

    const playing = new Promise<void>(resolve => {
      s1.on('gameState', (state) => { if (state.status === 'playing') resolve(); });
    });
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '200', cards: [], currentPlayerIndex: 0, round: 1,
        finished: false, gameTimeInSeconds: 0,
        players: [{ name: 'Alice', deviceId: 'dev-gtes-a', score: 0 }],
      },
    });
    await playing;

    backdateClock(roomId, 2000);

    const finished = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s1.on('gameState', (state) => { if (state.finished) resolve(state); });
    });
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '200', cards: [], currentPlayerIndex: 0, round: 1,
        finished: true, gameTimeInSeconds: 999, // stale client value — server must snapshot the real time
        players: [{ name: 'Alice', deviceId: 'dev-gtes-a', score: 100 }],
      },
    });

    const state = await finished;
    expect(state.gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    expect(state.gameTimeInSeconds).toBeLessThan(5);
  });

  it('continues from correct server time on reconnect', async () => {
    const roomId = 'GAME_TIME_RECONNECT';
    const s1 = await server.connectAndJoin(roomId, 'Alice', 'dev-gtr2-a'); // host
    const s2 = await server.connectAndJoin(roomId, 'Bob', 'dev-gtr2-b'); // observer, reconnects

    const s2Playing = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s2.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '200', cards: [], currentPlayerIndex: 0, round: 1,
        finished: false, gameTimeInSeconds: 0,
        players: [
          { name: 'Alice', deviceId: 'dev-gtr2-a', score: 0 },
          { name: 'Bob', deviceId: 'dev-gtr2-b', score: 0 },
        ],
      },
    });
    await s2Playing;

    backdateClock(roomId, 3000);

    // updatePlayerColor triggers a fresh emitRoomState so s2 observes the
    // backdated elapsed time before disconnecting.
    const s2Rebroadcast = new Promise<{ gameTimeInSeconds: number }>(resolve => s2.once('gameState', resolve));
    s1.emit('updatePlayerColor', { roomId, color: '#123456' });
    const atDisconnect = await s2Rebroadcast;
    const s2GameTimeAtDisconnect = atDisconnect.gameTimeInSeconds;
    expect(s2GameTimeAtDisconnect).toBeGreaterThanOrEqual(3);
    s2.disconnect();

    const s2New = await server.connect();
    const rejoinedPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s2New.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    void emitJoin(s2New, roomId, 'Bob', 'dev-gtr2-b', '#00ff00');

    const newState = await rejoinedPlaying;
    // Server-calculated time should be >= what it was at disconnect.
    expect(newState.gameTimeInSeconds).toBeGreaterThanOrEqual(s2GameTimeAtDisconnect);
    // Should not be the stale client value (e.g. 0 from initial push or 999).
    expect(newState.gameTimeInSeconds).toBeLessThan(10);
  });

  it('gameActualStartTime is preserved across turn/card changes (not reset on subsequent pushState)', async () => {
    const roomId = 'GAME_TIME_PERSIST';
    const s1 = await server.connectAndJoin(roomId, 'Alice', 'dev-gtp-a');

    const firstPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s1.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '200', cards: [], currentPlayerIndex: 0, round: 1,
        finished: false, gameTimeInSeconds: 0,
        players: [{ name: 'Alice', deviceId: 'dev-gtp-a', score: 0 }],
      },
    });
    const first = await firstPlaying;
    const firstGameTime = first.gameTimeInSeconds;

    backdateClock(roomId, 2000);

    const secondPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => s1.once('gameState', resolve));
    s1.emit('pushState', {
      roomId,
      newState: {
        status: 'playing', currentCard: '300', cards: [], currentPlayerIndex: 0, round: 1, // different card — should NOT reset gameActualStartTime
        finished: false, gameTimeInSeconds: 999, // stale client value — server must override
        players: [{ name: 'Alice', deviceId: 'dev-gtp-a', score: 0 }],
      },
    });

    // If gameActualStartTime had been reset, this would read ~0 instead of ~2.
    const second = await secondPlaying;
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    expect(second.gameTimeInSeconds).toBeLessThan(5);
    expect(second.gameTimeInSeconds).toBeGreaterThan(firstGameTime);
  });
});
