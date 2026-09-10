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
import { acceptOnlineAction, joinTestRoom, protocolClient, requestPublicState } from './onlineTestClient';
import { rooms } from './rooms';
import { DEFAULT_WINNING_SCORE } from '../src/utils/configValidation';

describe('game clock (gameTimeInSeconds / gameActualStartTime)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const connectAndJoin = async (roomId: string, name: string) => {
    const socket = protocolClient(`http://127.0.0.1:${server.port}`, { transports: ['websocket'] });
    await joinTestRoom(socket, roomId, name, { randomOrder: false });
    return socket;
  };

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
    const s1 = await connectAndJoin(roomId, 'Alice');
    await connectAndJoin(roomId, 'Bob');

    const first = await acceptOnlineAction(s1, roomId, { type: 'start' }, {
      gameTimeInSeconds: 999, // stale/wrong — server must ignore the snapshot
    });
    expect(first.gameTimeInSeconds).toBeDefined();
    expect(first.gameTimeInSeconds!).toBeLessThan(5);

    backdateClock(roomId, 2000);

    const second = await acceptOnlineAction(s1, roomId, { type: 'commit', score: 0, success: false }, {
      gameTimeInSeconds: 999, // still stale — server must still ignore the snapshot
    });
    expect(second.gameTimeInSeconds).toBeLessThan(5);
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(2);
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(first.gameTimeInSeconds!);
  });

  it('on game-end is the server-calculated elapsed time, not the stale client-pushed value', async () => {
    const roomId = 'GAME_TIME_END_SNAPSHOT';
    const s1 = await connectAndJoin(roomId, 'Alice');
    const s2 = await connectAndJoin(roomId, 'Bob');

    await acceptOnlineAction(s1, roomId, { type: 'start' });

    backdateClock(roomId, 2000);
    rooms[roomId].state.players[0].score = DEFAULT_WINNING_SCORE;
    await acceptOnlineAction(s1, roomId, { type: 'commit', score: 0, success: false });

    const state = await acceptOnlineAction(s2, roomId, { type: 'commit', score: 0, success: false }, {
      gameTimeInSeconds: 999, // stale client value — server must snapshot the real time
    });
    expect(state.gameTimeInSeconds).toBeDefined();
    expect(state.gameTimeInSeconds!).toBeGreaterThanOrEqual(1);
    expect(state.gameTimeInSeconds!).toBeLessThan(5);
  });

  it('continues from correct server time on reconnect', async () => {
    const roomId = 'GAME_TIME_RECONNECT';
    const s1 = await connectAndJoin(roomId, 'Alice'); // host
    const s2 = await connectAndJoin(roomId, 'Bob'); // observer, reconnects

    await acceptOnlineAction(s1, roomId, { type: 'start' });
    await requestPublicState(s2, roomId, state => state.status === 'playing');

    backdateClock(roomId, 3000);

    // requestState answers on the asking socket alone, so s2 observes the
    // backdated elapsed time before disconnecting. It goes through the same
    // buildGameStatePayload every broadcast does — gameTimeInSeconds included
    // — and deliberately does not bump the state version, which nothing here
    // asserts on. (updatePlayerColor used to serve as the rebroadcast trigger;
    // it is a lobby-only control now and returns silently mid-game.)
    const s2Rebroadcast = new Promise<{ gameTimeInSeconds: number }>(resolve => s2.once('gameState', resolve));
    s2.emit('requestState', { roomId });
    const atDisconnect = await s2Rebroadcast;
    const s2GameTimeAtDisconnect = atDisconnect.gameTimeInSeconds;
    expect(s2GameTimeAtDisconnect).toBeGreaterThanOrEqual(3);
    s2.disconnect();

    const s2New = await server.connect();
    const rejoinedPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s2New.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    void emitJoin(s2New, roomId, 'Bob', `dev-${roomId}-Bob`, '#00ff00');

    const newState = await rejoinedPlaying;
    // Server-calculated time should be >= what it was at disconnect.
    expect(newState.gameTimeInSeconds).toBeGreaterThanOrEqual(s2GameTimeAtDisconnect);
    // Should not be the stale client value (e.g. 0 from initial push or 999).
    expect(newState.gameTimeInSeconds).toBeLessThan(10);
  });

  it('gameActualStartTime is preserved across turn/card changes (not reset on subsequent pushState)', async () => {
    const roomId = 'GAME_TIME_PERSIST';
    const s1 = await connectAndJoin(roomId, 'Alice');
    await connectAndJoin(roomId, 'Bob');

    const first = await acceptOnlineAction(s1, roomId, { type: 'start' });
    expect(first.gameTimeInSeconds).toBeDefined();
    const firstGameTime = first.gameTimeInSeconds!;

    backdateClock(roomId, 2000);

    const second = await acceptOnlineAction(s1, roomId, { type: 'commit', score: 0, success: false }, {
      gameTimeInSeconds: 999, // stale client value — server must ignore the snapshot
    });

    // If gameActualStartTime had been reset, this would read ~0 instead of ~2.
    expect(second.gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    expect(second.gameTimeInSeconds).toBeLessThan(5);
    expect(second.gameTimeInSeconds).toBeGreaterThan(firstGameTime);
  });

  it('returning to the lobby banks the elapsed time and starts the next game from zero', async () => {
    // The two halves of the lobby reset -- banking the elapsed time and
    // dropping the anchor -- were removable TOGETHER with the suite still
    // green: every existing clock test either never leaves 'playing' or never
    // starts a second game, so nothing could tell a cleared anchor from a
    // kept one. Keeping it would carry the first game's whole duration into
    // the second, and every player's totalPlaytime with it.
    const roomId = 'GAME_TIME_LOBBY_RESET';
    const s1 = await connectAndJoin(roomId, 'Alice');
    await connectAndJoin(roomId, 'Bob');

    await acceptOnlineAction(s1, roomId, { type: 'start' });

    const ELAPSED_MS = 4000;
    const ELAPSED_SECONDS = ELAPSED_MS / 1000;
    backdateClock(roomId, ELAPSED_MS);

    // endGame: back to the lobby, roster untouched.
    const banked = await acceptOnlineAction(s1, roomId, { type: 'reset' });

    expect(banked.gameTimeInSeconds, 'the finished game\'s duration was not banked').toBe(ELAPSED_SECONDS);
    expect(rooms[roomId].gameActualStartTime, 'the anchor outlived the game it was anchoring').toBeNull();

    // Play Again from that lobby: the clock must start over, not resume.
    const second = await acceptOnlineAction(s1, roomId, { type: 'start' }, { gameTimeInSeconds: 999 });

    expect(second.gameTimeInSeconds, 'the new game inherited the old one\'s duration').toBe(0);
  });
});
