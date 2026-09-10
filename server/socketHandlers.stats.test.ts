/**
 * @vitest-environment node
 *
 * In-process socket suites for the stats submission flow: dedup rollback on
 * DB failure, the finished-game gate, and which mode a finished game is booked
 * under. Split out of socketHandlers.test.ts along the handler-module lines;
 * the database module is mocked (see socketTestHarness.ts on why in-process).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Socket as ClientSocket } from 'socket.io-client';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { updateDeviceStats, updateGlobalStats, getDeviceStats } from './database';
import { startInProcessServer, waitFor, settle, type InProcessServer } from './socketTestHarness';
import { rooms } from './rooms';
import { acceptOnlineAction, configureTestRoom, pushOnlineAction } from './onlineTestClient';
import { DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE } from '../src/utils/configValidation';

const mockedUpdateDeviceStats = vi.mocked(updateDeviceStats);
const mockedUpdateGlobalStats = vi.mocked(updateGlobalStats);
const mockedGetDeviceStats = vi.mocked(getDeviceStats);

describe('stats dedup rollback on DB failure', () => {
  let server: InProcessServer;
  let client: ClientSocket;

  beforeAll(async () => {
    // The rollback paths log the injected failures — keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateGlobalStats.mockReset();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  it('endGameStats: a failed DB write rolls back the dedup marker so a retry lands, then dedups for real', async () => {
    mockedUpdateDeviceStats.mockRejectedValueOnce(new Error('db down'));
    mockedUpdateDeviceStats.mockResolvedValue(true);

    client = await server.connectAndJoin('STATS_RETRY_DEV', 'Alice', 'dev-retry-1');
    // Stats are only accepted once the game has actually finished.
    rooms['STATS_RETRY_DEV'].state.finished = true;

    // First attempt: DB write fails — the dedup marker must be rolled back.
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);

    // Retry: must NOT be swallowed by the dedup (marker was rolled back).
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 2);

    // After a SUCCESSFUL write, a further submit for the same game is deduped.
    // No real DB or network I/O here — the mocked promises settle on the
    // microtask queue, so settle()'s short margin proves no further call landed.
    client.emit('endGameStats', { deviceId: 'dev-retry-1', stats: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateDeviceStats.mock.calls.length).toBe(2);

    client.disconnect();
  });

  it('endGameStats derives counters from the server and ignores a hostile payload', async () => {
    // sanitizeStats has thorough unit tests and an HTTP-route test; the SOCKET
    // route -- the one every real client uses -- had none, so deleting the
    // call here left the suite green. The values below are the three shapes
    // that do permanent damage if they land: fastestWinTurns is MIN-merged
    // (so a 0 or a `false` binding to 0 pins the best-ever count with no way
    // back), and a record merged with MAX keeps whatever junk it was given.
    mockedUpdateDeviceStats.mockResolvedValue(true);

    client = await server.connectAndJoin('STATS_HOSTILE_DEV', 'Alice', 'dev-hostile-1');
    rooms['STATS_HOSTILE_DEV'].state.finished = true;
    rooms['STATS_HOSTILE_DEV'].state.players[0].totalTurns = 3;

    client.emit('endGameStats', {
      deviceId: 'dev-hostile-1',
      stats: {
        gamesPlayed: 1,
        fastestWinTurns: 0,
        fastestLossTurns: false,
        highestTurnScore: 'NaN',
        busts: -5,
      },
    });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);

    const written = mockedUpdateDeviceStats.mock.calls[0][1] as Record<string, unknown>;
    expect(written.fastestWinTurns).toBe(3);
    expect(written.fastestLossTurns).toBeNull();
    expect(written.highestTurnScore).toBe(0);
    expect(written.busts, 'counters are floored at 0').toBe(0);
    // Unknown columns are not this layer's problem: updateDeviceStats writes
    // only the columns on its own hardcoded list, so an extra key never
    // reaches SQL. Values are what sanitizeStats is here for.

    client.disconnect();
  });

  it('submitGlobalStats: a failed DB write rolls back the dedup flag so a retry lands, then dedups for real', async () => {
    mockedUpdateGlobalStats.mockRejectedValueOnce(new Error('db down'));
    mockedUpdateGlobalStats.mockResolvedValue(1);

    // First join creates the room with this socket as host — required for
    // submitGlobalStats to be accepted.
    client = await server.connectAndJoin('STATS_RETRY_GLOBAL', 'Alice', 'dev-retry-2');
    // Stats are only accepted once the game has actually finished.
    rooms['STATS_RETRY_GLOBAL'].state.finished = true;

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 1);

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 2);

    client.emit('submitGlobalStats', { roomId: 'STATS_RETRY_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateGlobalStats.mock.calls.length).toBe(2);

    client.disconnect();
  });

  it('endGameStats: refreshes the winning player\'s in-room winStreak and broadcasts it, instead of leaving it stale until the next join', async () => {
    mockedUpdateDeviceStats.mockResolvedValue(true);
    // Player joined with no prior streak...
    mockedGetDeviceStats.mockResolvedValueOnce(null);
    client = await server.connectAndJoin('STATS_STREAK_ROOM', 'Alice', 'dev-streak-1');
    // Stats are only accepted once the game has actually finished.
    rooms['STATS_STREAK_ROOM'].state.finished = true;

    // deviceId is stripped from broadcast state (it's a reconnect credential), so
    // match by name instead — same as the client would.
    const gameStatePromise = new Promise<{ players: { name: string; winStreak?: number }[] }>(resolve => {
      client.on('gameState', (state) => {
        const alice = state.players.find((p: { name: string }) => p.name === 'Alice');
        if (alice?.winStreak === 4) resolve(state);
      });
    });

    // ...but just won, extending the streak to 4 (as computed server-side by the DB layer).
    mockedGetDeviceStats.mockResolvedValueOnce({ currentWinStreak: 4 } as Awaited<ReturnType<typeof getDeviceStats>>);
    client.emit('endGameStats', { deviceId: 'dev-streak-1', stats: { gamesPlayed: 1, wins: 1 } });

    await gameStatePromise;

    client.disconnect();
  });
});

describe('stats submissions require a finished game', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateGlobalStats.mockReset();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  it('ignores endGameStats while the game has not finished (e.g. straight from the lobby)', async () => {
    mockedUpdateDeviceStats.mockResolvedValue(true);
    const sock = await server.connectAndJoin('STATS_UNFINISHED_DEV', 'Alice', 'dev-unfinished-1');

    sock.emit('endGameStats', { deviceId: 'dev-unfinished-1', stats: { gamesPlayed: 1, wins: 1 } });
    // The finished gate is a synchronous check ahead of any DB call — a short
    // margin is enough to prove the write never happened.
    await settle();

    expect(mockedUpdateDeviceStats).not.toHaveBeenCalled();
    // The dedup marker must not have been consumed by the rejected attempt —
    // a later legitimate submission (once finished) still lands.
    rooms['STATS_UNFINISHED_DEV'].state.finished = true;
    sock.emit('endGameStats', { deviceId: 'dev-unfinished-1', stats: { gamesPlayed: 1, wins: 1 } });
    await settle();
    expect(mockedUpdateDeviceStats).toHaveBeenCalledTimes(1);
  });

  it('ignores submitGlobalStats while the game has not finished', async () => {
    mockedUpdateGlobalStats.mockResolvedValue(1);
    const sock = await server.connectAndJoin('STATS_UNFINISHED_GLOBAL', 'Alice', 'dev-unfinished-2');

    sock.emit('submitGlobalStats', { roomId: 'STATS_UNFINISHED_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();

    expect(mockedUpdateGlobalStats).not.toHaveBeenCalled();
    rooms['STATS_UNFINISHED_GLOBAL'].state.finished = true;
    sock.emit('submitGlobalStats', { roomId: 'STATS_UNFINISHED_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateGlobalStats).toHaveBeenCalledTimes(1);
  });
});

describe('the game mode a finished game is recorded under', () => {
  let server: InProcessServer;
  beforeAll(async () => { server = await startInProcessServer(); });
  afterAll(async () => { await server.close(); });
  beforeEach(() => {
    mockedUpdateGlobalStats.mockReset();
    mockedUpdateGlobalStats.mockResolvedValue(1);
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateDeviceStats.mockResolvedValue(true);
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });
  const CUSTOM_SCORE = 1000;
  const CUSTOM_DECK = { ...DEFAULT_INITIAL_CARDS, Kleeblatt: 42 };
  const peers = new Map<string, ClientSocket>();
  const deviceFor = (roomId: string) => `dev-${roomId}`;
  const hostAGame = async (roomId: string, config: Record<string, unknown> = {}) => {
    const host = await server.connectAndJoin(roomId, 'Alice', deviceFor(roomId));
    peers.set(roomId, await server.connectAndJoin(roomId, 'Bob', `${deviceFor(roomId)}-peer`));
    await configureTestRoom(host, roomId, { randomOrder: false, turnDuration: 0, ...config });
    await acceptOnlineAction(host, roomId, { type: 'start' });
    return host;
  };
  const finishTheGame = async (host: ClientSocket, roomId: string) => {
    // Deterministic server-private deal fixture; the score, finish, metadata
    // and stats remain derived by the actual action/handler path.
    const room = rooms[roomId];
    room.state.currentCard = '200';
    room.dealtThisTurn = ['200'];
    await acceptOnlineAction(host, roomId, { type: 'commit', score: room.state.winningScore, success: true });
    await acceptOnlineAction(peers.get(roomId)!, roomId, { type: 'commit', score: 0, success: false });
    expect(room.state.finished).toBe(true);
  };
  const submitAndReadMode = async (host: ClientSocket, roomId: string, claimed?: boolean) => {
    await finishTheGame(host, roomId);
    host.emit('submitGlobalStats', { roomId, payload: { gamesPlayed: 99, isDefaultGame: claimed } });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 1);
    return mockedUpdateGlobalStats.mock.calls[0][0].isDefaultGame;
  };

  it('records default configuration as normalized', async () => {
    const roomId = 'MODE_DEFAULT';
    const host = await hostAGame(roomId);
    expect(await submitAndReadMode(host, roomId)).toBe(true);
  });
  it('records lobby custom configuration as custom despite a client claiming default', async () => {
    const roomId = 'MODE_CUSTOM';
    const host = await hostAGame(roomId, { initialCards: CUSTOM_DECK });
    expect(await submitAndReadMode(host, roomId, true)).toBe(false);
  });
  it('ignores a configuration smuggled into a rematch action snapshot', async () => {
    const roomId = 'MODE_SMUGGLED';
    const host = await hostAGame(roomId);
    await finishTheGame(host, roomId);
    await acceptOnlineAction(host, roomId, { type: 'start' }, { initialCards: CUSTOM_DECK });
    expect(rooms[roomId].state.initialCards).toEqual(DEFAULT_INITIAL_CARDS);
    expect(await submitAndReadMode(host, roomId)).toBe(true);
  });
  it('keeps the custom classification when server configuration is restored', async () => {
    const roomId = 'MODE_RESTORED';
    const host = await hostAGame(roomId, { winningScore: CUSTOM_SCORE });
    rooms[roomId].state.winningScore = DEFAULT_WINNING_SCORE;
    expect(await submitAndReadMode(host, roomId)).toBe(false);
  });
  it('downgrades classification if the server configuration ceases to be default', async () => {
    const roomId = 'MODE_MIDGAME';
    const host = await hostAGame(roomId);
    rooms[roomId].state.winningScore = CUSTOM_SCORE;
    expect(await submitAndReadMode(host, roomId)).toBe(false);
  });
  it('ignores midgame snapshot configuration while accepting a valid action', async () => {
    const roomId = 'MODE_MIDGAME_REFUSED';
    const host = await hostAGame(roomId);
    const room = rooms[roomId];
    room.state.currentCard = '200';
    room.dealtThisTurn = ['200'];
    const ack = await pushOnlineAction(host, roomId, { type: 'commit', score: 0, success: false },
      { winningScore: CUSTOM_SCORE, round: 99 });
    expect(ack.ok).toBe(true);
    expect(room.state.winningScore).toBe(DEFAULT_WINNING_SCORE);
    expect(room.state.round).toBe(1);
    expect(room.state.currentPlayerIndex).toBe(1);
  });
  it.each([false, true])('writes device stats to the authoritative bucket (custom=%s)', async custom => {
    const roomId = `MODE_DEVICE_${custom}`.toUpperCase();
    const host = await hostAGame(roomId, custom ? { initialCards: CUSTOM_DECK } : {});
    await finishTheGame(host, roomId);
    mockedGetDeviceStats.mockClear();
    host.emit('endGameStats', { deviceId: deviceFor(roomId), stats: { gamesPlayed: 99, wins: 99 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);
    expect(mockedUpdateDeviceStats.mock.calls[0][2]).toBe(custom ? 'custom' : 'normalized');
    if (custom) expect(mockedGetDeviceStats).not.toHaveBeenCalled();
    else await waitFor(() => mockedGetDeviceStats.mock.calls.length === 1);
  });
  it('re-evaluates configuration when Play Again skips the lobby', async () => {
    const roomId = 'MODE_PLAY_AGAIN';
    const host = await hostAGame(roomId, { initialCards: CUSTOM_DECK });
    await finishTheGame(host, roomId);
    // Server-side setup fixture proves kickoff re-freezes configuration;
    // wire configuration edits remain lobby-only.
    rooms[roomId].state.initialCards = { ...DEFAULT_INITIAL_CARDS };
    await acceptOnlineAction(host, roomId, { type: 'start' });
    expect(await submitAndReadMode(host, roomId)).toBe(true);
  });
});
