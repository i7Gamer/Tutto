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

  it('endGameStats sanitizes a hostile payload before it reaches the database', async () => {
    // sanitizeStats has thorough unit tests and an HTTP-route test; the SOCKET
    // route -- the one every real client uses -- had none, so deleting the
    // call here left the suite green. The values below are the three shapes
    // that do permanent damage if they land: fastestWinTurns is MIN-merged
    // (so a 0 or a `false` binding to 0 pins the best-ever count with no way
    // back), and a record merged with MAX keeps whatever junk it was given.
    mockedUpdateDeviceStats.mockResolvedValue(true);

    client = await server.connectAndJoin('STATS_HOSTILE_DEV', 'Alice', 'dev-hostile-1');
    rooms['STATS_HOSTILE_DEV'].state.finished = true;

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
    expect(written.fastestWinTurns, 'a 0-turn best would be MIN-merged and permanent').toBe(1);
    expect(written, 'a boolean binds to 0 and pins the record just the same').not.toHaveProperty('fastestLossTurns');
    expect(written, 'a non-numeric record must not reach a MAX merge').not.toHaveProperty('highestTurnScore');
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
  let client: ClientSocket;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    mockedUpdateGlobalStats.mockReset();
    mockedUpdateGlobalStats.mockResolvedValue(1);
  });

  const CUSTOM_DECK = { ...DEFAULT_INITIAL_CARDS, Kleeblatt: 42 };

  // One device may only be in one room at a time, so each case gets its own —
  // derived from the room id rather than written out twice.
  const deviceFor = (roomId: string): string => `dev-${roomId}`;

  // Joins as the room's host, which is who both pushState and submitGlobalStats
  // require. Returns once the room exists and this socket owns it.
  const hostAGame = (roomId: string): Promise<ClientSocket> =>
    server.connectAndJoin(roomId, 'Alice', deviceFor(roomId));

  const push = (sock: ClientSocket, roomId: string, newState: Record<string, unknown>): void => {
    sock.emit('pushState', {
      roomId,
      newState: {
        status: 'playing',
        finished: false,
        currentPlayerIndex: 0,
        round: 1,
        players: [{ name: 'Alice', deviceId: deviceFor(roomId), score: 0 }],
        ...newState,
      },
    });
  };

  // The client's own isDefaultGame is advisory; every case below asserts what
  // the SERVER decided, by reading the flag the DB layer actually received.
  const submitAndReadMode = async (sock: ClientSocket, roomId: string, claimed?: boolean): Promise<boolean> => {
    rooms[roomId].state.finished = true;
    sock.emit('submitGlobalStats', {
      roomId,
      payload: { gamesPlayed: 1, ...(claimed === undefined ? {} : { isDefaultGame: claimed }) },
    });
    await waitFor(() => mockedUpdateGlobalStats.mock.calls.length === 1);
    return mockedUpdateGlobalStats.mock.calls[0][0].isDefaultGame as boolean;
  };

  it('records a game started on the default config as normalized', async () => {
    const roomId = 'MODE_DEFAULT';
    client = await hostAGame(roomId);
    push(client, roomId, { winningScore: DEFAULT_WINNING_SCORE, initialCards: { ...DEFAULT_INITIAL_CARDS } });
    await waitFor(() => rooms[roomId].state.status === 'playing');

    expect(await submitAndReadMode(client, roomId)).toBe(true);
    client.disconnect();
  });

  it('records a game as custom when only the OPENING PUSH carries the custom config', async () => {
    // The lobby never saw the custom deck: it rides in on the same push that
    // starts the game. Deciding the mode before that push is applied would
    // read the untouched lobby config and call this game normalized.
    const roomId = 'MODE_OPENING_PUSH';
    client = await hostAGame(roomId);
    expect(rooms[roomId].state.initialCards).toEqual(DEFAULT_INITIAL_CARDS);

    push(client, roomId, { initialCards: { ...CUSTOM_DECK } });
    await waitFor(() => rooms[roomId].state.status === 'playing');

    expect(await submitAndReadMode(client, roomId)).toBe(false);
    client.disconnect();
  });

  it('keeps a custom game custom when the config goes back to the default before the end', async () => {
    const roomId = 'MODE_RESTORED';
    client = await hostAGame(roomId);
    // The opening push carries the custom score, which is the only way a
    // config reaches a running game now.
    push(client, roomId, { winningScore: 1000 });
    await waitFor(() => rooms[roomId].state.winningScore === 1000);
    expect(rooms[roomId].normalizedGame).toBe(false);

    // The config comes back to the default by some route other than a config
    // push, which the server refuses outright (see the test below). The label
    // must not follow it back up: `&&=` is what makes the downgrade one-way,
    // and a plain `=` would pass every other case in this file.
    rooms[roomId].state.winningScore = DEFAULT_WINNING_SCORE;
    push(client, roomId, { round: 2 });
    await waitFor(() => rooms[roomId].state.round === 2);

    expect(await submitAndReadMode(client, roomId)).toBe(false);
    client.disconnect();
  });

  it('downgrades a normalized game to custom if the config ever stops being the default', async () => {
    // Start honest, then have the running game's config differ from the
    // default by the time the statistics are submitted. Freezing the label at
    // kickoff alone would still call this normalized.
    const roomId = 'MODE_MIDGAME';
    client = await hostAGame(roomId);
    push(client, roomId, { winningScore: DEFAULT_WINNING_SCORE });
    await waitFor(() => rooms[roomId].state.status === 'playing');
    expect(rooms[roomId].normalizedGame).toBe(true);

    rooms[roomId].state.winningScore = 1000;
    push(client, roomId, { round: 2 });
    await waitFor(() => rooms[roomId].state.round === 2);

    expect(await submitAndReadMode(client, roomId)).toBe(false);
    client.disconnect();
  });

  it('refuses a mid-game config push, which is what makes the downgrade a backstop', async () => {
    // updateConfig has refused this since it was written; pushState reaches
    // the same fields and enforced it for `ruleset` alone. Driven through the
    // real socket handler rather than applyPushedState directly, because the
    // half that was missing was the CALLER deciding when a config write is
    // allowed at all.
    const roomId = 'MODE_MIDGAME_REFUSED';
    client = await hostAGame(roomId);
    push(client, roomId, { winningScore: DEFAULT_WINNING_SCORE });
    await waitFor(() => rooms[roomId].state.status === 'playing');

    // `round` rides the same payload as proof the push itself landed —
    // without it, an entirely dropped push would read as a refused field.
    push(client, roomId, { winningScore: 1000, round: 2 });
    await waitFor(() => rooms[roomId].state.round === 2);

    expect(rooms[roomId].state.winningScore, 'the win condition moved under a running game').toBe(DEFAULT_WINNING_SCORE);
    client.disconnect();
  });

  it('overrides a client claiming a custom game was the default one', async () => {
    const roomId = 'MODE_LIAR';
    client = await hostAGame(roomId);
    push(client, roomId, { initialCards: { ...CUSTOM_DECK } });
    await waitFor(() => rooms[roomId].state.status === 'playing');

    expect(await submitAndReadMode(client, roomId, true)).toBe(false);
    client.disconnect();
  });

  it('books a custom game into the custom bucket, leaving the shown win streak alone', async () => {
    // The streak next to a player is the normalized one — a custom game must
    // neither extend it nor trigger a broadcast that replaces it with the
    // custom bucket's unrelated count.
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateDeviceStats.mockResolvedValue(true);
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);

    const roomId = 'MODE_DEVICE_CUSTOM';
    client = await hostAGame(roomId);
    push(client, roomId, { initialCards: { ...CUSTOM_DECK } });
    await waitFor(() => rooms[roomId].state.status === 'playing');
    rooms[roomId].state.finished = true;

    // joinRoom reads the streak too — only what happens AFTER the game is of
    // interest here.
    mockedGetDeviceStats.mockClear();
    client.emit('endGameStats', { deviceId: deviceFor(roomId), stats: { gamesPlayed: 1, wins: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);

    expect(mockedUpdateDeviceStats.mock.calls[0][2]).toBe('custom');
    // No streak re-read, so nothing to broadcast.
    expect(mockedGetDeviceStats).not.toHaveBeenCalled();

    client.disconnect();
  });

  it('books a normalized game into the normalized bucket and still refreshes the streak', async () => {
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateDeviceStats.mockResolvedValue(true);
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);

    const roomId = 'MODE_DEVICE_NORMAL';
    client = await hostAGame(roomId);
    push(client, roomId, { winningScore: DEFAULT_WINNING_SCORE });
    await waitFor(() => rooms[roomId].state.status === 'playing');
    rooms[roomId].state.finished = true;

    mockedGetDeviceStats.mockClear();
    client.emit('endGameStats', { deviceId: deviceFor(roomId), stats: { gamesPlayed: 1, wins: 1 } });
    await waitFor(() => mockedUpdateDeviceStats.mock.calls.length === 1);

    expect(mockedUpdateDeviceStats.mock.calls[0][2]).toBe('normalized');
    await waitFor(() => mockedGetDeviceStats.mock.calls.length === 1);

    client.disconnect();
  });

  it('re-evaluates the mode for the next game when "Play Again" skips the lobby', async () => {
    const roomId = 'MODE_PLAY_AGAIN';
    client = await hostAGame(roomId);
    push(client, roomId, { initialCards: { ...CUSTOM_DECK } });
    await waitFor(() => rooms[roomId].state.status === 'playing');

    // Finish that custom game, then start a fresh one on the default deck
    // without ever returning to the lobby — the room stays status 'playing'.
    push(client, roomId, { finished: true, initialCards: { ...CUSTOM_DECK } });
    await waitFor(() => rooms[roomId].state.finished === true);
    push(client, roomId, { finished: false, initialCards: { ...DEFAULT_INITIAL_CARDS } });
    await waitFor(() => rooms[roomId].state.finished === false);

    expect(await submitAndReadMode(client, roomId)).toBe(true);
    client.disconnect();
  });
});
