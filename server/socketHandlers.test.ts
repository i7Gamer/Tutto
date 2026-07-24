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
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { updateDeviceStats, updateGlobalStats, getDeviceStats } from './database';
import { registerSocketHandlers } from './socketHandlers';
import { rooms, createRoom, deleteRoom, MAX_PLAYERS_PER_ROOM, MAX_ROOMS } from './rooms';
import type { ServerPlayer } from './roomTypes';

const mockedUpdateDeviceStats = vi.mocked(updateDeviceStats);
const mockedUpdateGlobalStats = vi.mocked(updateGlobalStats);
const mockedGetDeviceStats = vi.mocked(getDeviceStats);

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
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
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

  // No real DB or network I/O here — updateDeviceStats/updateGlobalStats are
  // mocked promises that resolve/reject on the microtask queue, so a short
  // margin is enough to prove no further call landed.
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

  it('endGameStats: a failed DB write rolls back the dedup marker so a retry lands, then dedups for real', async () => {
    mockedUpdateDeviceStats.mockRejectedValueOnce(new Error('db down'));
    mockedUpdateDeviceStats.mockResolvedValue(true);

    client = await connectAndJoin('STATS_RETRY_DEV', 'Alice', 'dev-retry-1');
    // Stats are only accepted once the game has actually finished.
    rooms['STATS_RETRY_DEV'].state.finished = true;

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
    client = await connectAndJoin('STATS_STREAK_ROOM', 'Alice', 'dev-streak-1');
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

describe('Socket event rate limiting (SERVER-XC-3)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  let client: ClientSocket;

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (client) client.disconnect();
    await ioServer.close();
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

  // The rate limiter is a synchronous per-event counter check — no async I/O
  // in the hot path — so a short margin is enough to prove drops happened.
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

  it('drops updateConfig events past the per-connection cap instead of applying every one', async () => {
    client = await connectAndJoin('RATE_LIMIT_CONFIG', 'Host', 'dev-ratelimit-1');

    let latestWinningScore: number | undefined;
    client.on('gameState', (state: { winningScore: number }) => {
      latestWinningScore = state.winningScore;
    });

    // updateConfig's cap is 20/second — fire one more than that in immediate
    // succession, each with a distinct winningScore so the applied count is
    // directly observable in the broadcast state.
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
    client = await connectAndJoin('RATE_LIMIT_REORDER', 'Host', 'dev-ratelimit-reorder-1');
    const peer = await connectAndJoin('RATE_LIMIT_REORDER', 'Peer', 'dev-ratelimit-reorder-2');

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
    client = await connectAndJoin('RATE_LIMIT_COLOR', 'Host', 'dev-ratelimit-color-1');

    // The cap is 20/second — fire 21 distinct colors. The 20th (i=19,
    // '#000023') must be the last one applied; the 21st ('#000024') dropped.
    for (let i = 0; i < 21; i++) {
      client.emit('updatePlayerColor', { roomId: 'RATE_LIMIT_COLOR', color: `#0000${(16 + i).toString(16)}` });
    }

    await settle();

    expect(rooms['RATE_LIMIT_COLOR'].state.players[0].color).toBe('#000023');
  });
});

describe('joinRoom await-window races (BUG-3)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  interface JoinAck { success: boolean; error?: string }

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
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  beforeEach(() => {
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  const connectSock = (): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => resolve(sock));
      sock.on('connect_error', reject);
    });

  const emitJoin = (sock: ClientSocket, roomId: string, name: string, deviceId: string): Promise<JoinAck> =>
    new Promise(resolve => {
      sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, resolve);
    });

  const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise(r => setTimeout(r, 10));
    }
  };

  it('seats a device in at most one room when two fresh joins interleave at the stats fetch', async () => {
    // Hold BOTH joins' getDeviceStats calls open simultaneously, so each
    // one's membership checks would run against a registry the other hasn't
    // written to yet if any check-then-mutate spanned the await.
    const releases: Array<() => void> = [];
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { releases.push(() => resolve(null)); }),
    );

    const [sockA, sockB] = await Promise.all([connectSock(), connectSock()]);
    const ackA = emitJoin(sockA, 'RACE_DEVICE_A', 'Alice', 'dev-race-shared');
    const ackB = emitJoin(sockB, 'RACE_DEVICE_B', 'Alice', 'dev-race-shared');

    await waitFor(() => releases.length === 2);
    releases.forEach(release => release());

    const results = await Promise.all([ackA, ackB]);

    // Exactly one join wins; the other is rejected by the one-room-per-device rule.
    expect(results.filter(r => r.success).length).toBe(1);
    const seatedRooms = ['RACE_DEVICE_A', 'RACE_DEVICE_B']
      .filter(id => rooms[id]?.state.players.some(p => p.deviceId === 'dev-race-shared'));
    expect(seatedRooms.length).toBe(1);
  });

  it('keeps the ack and the room registry consistent when the room is torn down mid-join', async () => {
    // Normal first join creates and seats the room.
    const sockA = await connectSock();
    const first = await emitJoin(sockA, 'RACE_TEARDOWN', 'Alice', 'dev-race-teardown');
    expect(first.success).toBe(true);

    // Simulated reload: a second socket rejoins the same seat, with its stats
    // fetch held open. While it is pending, the room is torn down — the same
    // effect a reconnect-timeout timer firing at that moment has.
    let release: (() => void) | undefined;
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { release = () => resolve(null); }),
    );
    const sockB = await connectSock();
    const ackPromise = emitJoin(sockB, 'RACE_TEARDOWN', 'Alice', 'dev-race-teardown');
    await waitFor(() => release !== undefined);

    deleteRoom('RACE_TEARDOWN');
    release!();

    const ack = await ackPromise;

    // Success must mean actually seated in a live room — pre-fix, the handler
    // mutated the deleted room object, acked success, and left the registry
    // empty (the client believed it was in a room the server didn't have).
    expect(ack.success).toBe(true);
    expect(rooms['RACE_TEARDOWN']?.state.players.some(p => p.deviceId === 'dev-race-teardown')).toBe(true);
  });
});

describe('joinRoom race window (SERVER-SH-3)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  let hostClient: ClientSocket;
  let joiningClient: ClientSocket;

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (hostClient) hostClient.disconnect();
    if (joiningClient) joiningClient.disconnect();
    await ioServer.close();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  it('never lets a joining socket receive a room broadcast before it is in room.state.players', async () => {
    // getDeviceStats is the awaited call that used to sit between socket.join()
    // and room.state.players.push() — hold it open here to widen that window
    // as much as possible, so a lingering race would be very likely to show up.
    let resolveStats: (() => void) | undefined;
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { resolveStats = () => resolve(null); }),
    );
    const waitForPendingStatsCall = (): Promise<void> => new Promise(resolve => {
      const check = (): void => { if (resolveStats) resolve(); else setTimeout(check, 10); };
      check();
    });

    const hostConnected = new Promise<ClientSocket>((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sock.on('connect', () => resolve(sock));
      sock.on('connect_error', reject);
    });
    hostClient = await hostConnected;

    const hostJoinPromise = new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      hostClient.emit('joinRoom', { roomId: 'RACE_ROOM', name: 'Host', deviceId: 'dev-race-host', color: '#ff0000' }, (res: { success: boolean; error?: string }) => {
        if (!res.success) return reject(new Error(res.error));
        resolve(res);
      });
    });
    // The host's own join also awaits getDeviceStats — let it resolve so only
    // the joining client's call is left hanging below.
    await waitForPendingStatsCall();
    resolveStats!();
    await hostJoinPromise;

    // Reset the mock so the joining client's own call gets a fresh, still-pending promise.
    resolveStats = undefined;

    const receivedBeforeJoin: unknown[] = [];
    joiningClient = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    joiningClient.on('gameState', (state) => receivedBeforeJoin.push(state));

    const joinPromise = new Promise<{ success: boolean; error?: string }>(resolve => {
      joiningClient.on('connect', () => {
        joiningClient.emit('joinRoom', { roomId: 'RACE_ROOM', name: 'Joiner', deviceId: 'dev-race-joiner', color: '#00ff00' }, resolve);
      });
    });

    // Wait until the joining client's getDeviceStats call is actually pending.
    await waitForPendingStatsCall();

    // While the joiner's join is still pending, the host triggers a broadcast.
    // Pre-fix, the joiner's socket had already called socket.join(roomId) at
    // this point (before its own await), so it would receive this and see a
    // roster missing itself. Post-fix, it hasn't joined the Socket.IO room
    // yet, so it must receive nothing here.
    hostClient.emit('updateConfig', { roomId: 'RACE_ROOM', winningScore: 5000 });
    await new Promise(r => setTimeout(r, 60));
    expect(receivedBeforeJoin).toEqual([]);

    // Now let the joiner's own getDeviceStats resolve and complete the join.
    resolveStats!();
    const joinResult = await joinPromise;
    expect(joinResult.success).toBe(true);

    // The very first broadcast the joiner receives (its own join's
    // emitRoomState) must already include itself.
    await new Promise(r => setTimeout(r, 60));
    const firstState = receivedBeforeJoin[0] as { players: { name: string }[] } | undefined;
    expect(firstState?.players.some(p => p.name === 'Joiner')).toBe(true);
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

  it('ignores a kickPlayer payload that is not a string', async () => {
    const host = await connectAndJoin('MALFORMED_KICK_ROOM', 'Host', 'dev-mk-h');
    const peer = await connectAndJoin('MALFORMED_KICK_ROOM', 'Peer', 'dev-mk-p');

    const peerKicked = vi.fn();
    peer.on('kicked', peerKicked);

    host.emit('kickPlayer', { socketId: peer.id });
    host.emit('kickPlayer', null);
    host.emit('kickPlayer', 42);

    // Give the malformed emits a tick to be (mis)handled, then confirm a
    // real kick still works — proving the handler didn't crash or leave the
    // room in a bad state.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(peerKicked).not.toHaveBeenCalled();
    expect(rooms['MALFORMED_KICK_ROOM'].state.players.map(p => p.name)).toEqual(['Host', 'Peer']);

    const validKick = new Promise<void>(resolve => peer.on('kicked', () => resolve()));
    host.emit('kickPlayer', peer.id);
    await validKick;
    expect(rooms['MALFORMED_KICK_ROOM'].state.players.map(p => p.name)).toEqual(['Host']);
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

  it('handles getDeviceStats failure gracefully during joinRoom', async () => {
    mockedGetDeviceStats.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res } = await joinRaw('DB_FAIL_ROOM', 'Eve', 'dev-fail-1');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Eve');
    expect(rooms['DB_FAIL_ROOM'].state.players[0].winStreak).toBe(0);
  });
});

describe('room capacity cap', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  // Prefixed per-room (not just per-index) — a device may now hold a seat in
  // only one room at a time (see the "one device, one room" cap below), so
  // reusing plain 'dev-filler-N' ids across the two tests in this block would
  // make the second test's reconnecting device look like it's still seated in
  // the first test's room and get rejected.
  const makeFillerPlayer = (roomPrefix: string, i: number): ServerPlayer => ({
    name: `Filler${i}`, deviceId: `dev-filler-${roomPrefix}-${i}`, socketId: `sock-filler-${roomPrefix}-${i}`,
    score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0, timesPlusMinusCompleted: 0,
    timesKniffelFailed: 0, timesKleeblattFailed: 0, timesKleeblattCompleted: 0, timesPlusMinusFailed: 0,
    timesFeuerwerkReceived: 0, timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
    feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0, position: 0,
    color: '#ff0000', disconnected: false,
  });

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

  it('rejects a fresh join once the room already holds MAX_PLAYERS_PER_ROOM players', async () => {
    const roomId = 'FULL_ROOM';
    // Seeded directly rather than via 100 real joinRoom round-trips — this test
    // is about the cap check itself, not about exercising 100 real sockets.
    rooms[roomId] = createRoom('fake-host-socket');
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      rooms[roomId].state.players.push(makeFillerPlayer('full', i));
    }

    const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    sockets.push(sock);
    const res = await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name: 'OneTooMany', deviceId: 'dev-overflow', color: '#00ff00' }, resolve);
      });
      sock.on('connect_error', reject);
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Room is full');
    expect(rooms[roomId].state.players.length).toBe(MAX_PLAYERS_PER_ROOM);
  });

  it('still allows an existing seated player (reconnect) into a full room', async () => {
    const roomId = 'FULL_ROOM_RECONNECT';
    rooms[roomId] = createRoom('fake-host-socket');
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      rooms[roomId].state.players.push(makeFillerPlayer('reconnect', i));
    }
    // Filler0 "disconnects" (as the reconnect path checks) so its seat can be
    // reclaimed — the cap must only block NEW players, not reconnects, since
    // a reconnect doesn't grow the roster.
    rooms[roomId].state.players[0].disconnected = true;

    const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    sockets.push(sock);
    const res = await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name: 'Filler0', deviceId: 'dev-filler-reconnect-0', color: '#00ff00' }, resolve);
      });
      sock.on('connect_error', reject);
    });

    expect(res.success).toBe(true);
    expect(rooms[roomId].state.players.length).toBe(MAX_PLAYERS_PER_ROOM);
  });
});

describe('device room exclusivity (one device, one room)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  interface JoinAck { success: boolean; error?: string }

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

  const connectAndJoin = (roomId: string, name: string, deviceId: string): Promise<{ sock: ClientSocket; res: JoinAck }> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => resolve({ sock, res }));
      });
      sock.on('connect_error', reject);
    });

  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

  it('rejects a second room for a deviceId already seated (connected) in another room, via a different socket', async () => {
    await connectAndJoin('EXCL_ROOM_A', 'Alice', 'dev-excl-1');

    // A second tab/socket from the same device (e.g. same browser localStorage)
    // tries to spin up a different room while the first seat is still live.
    const { res } = await connectAndJoin('EXCL_ROOM_B', 'Alice', 'dev-excl-1');

    expect(res.success).toBe(false);
    expect(res.error).toBe('This device is already in another room. Leave it before joining a new one.');
    // Must not create an empty room as a side effect of the rejected attempt.
    expect(rooms['EXCL_ROOM_B']).toBeUndefined();
  });

  it('still blocks a second room while the first seat is merely disconnected (not yet timed out)', async () => {
    const { sock: s1 } = await connectAndJoin('EXCL_ROOM_C', 'Bob', 'dev-excl-2');
    s1.disconnect();
    await settle(); // let the server mark the seat disconnected

    const { res } = await connectAndJoin('EXCL_ROOM_D', 'Bob', 'dev-excl-2');

    expect(res.success).toBe(false);
    expect(res.error).toBe('This device is already in another room. Leave it before joining a new one.');
  });

  it('allows a new room once the device has explicitly left its previous one', async () => {
    const { sock: s1 } = await connectAndJoin('EXCL_ROOM_E', 'Carol', 'dev-excl-3');
    s1.emit('leaveRoom');
    await settle();

    const { res } = await connectAndJoin('EXCL_ROOM_F', 'Carol', 'dev-excl-3');

    expect(res.success).toBe(true);
  });

  it('does not block a reconnect/rejoin into the SAME room the device is already seated in', async () => {
    await connectAndJoin('EXCL_ROOM_G', 'Dave', 'dev-excl-4');

    // e.g. a page reload issuing a brand-new socket connection for the same room.
    const { res } = await connectAndJoin('EXCL_ROOM_G', 'Dave', 'dev-excl-4');

    expect(res.success).toBe(true);
    expect(rooms['EXCL_ROOM_G'].state.players.length).toBe(1);
  });
});

describe('room deletion clears pending disconnect timers', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  interface JoinAck { success: boolean; error?: string; isHost?: boolean }

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

  const connectAndJoin = (roomId: string, name: string, deviceId: string): Promise<{ sock: ClientSocket; res: JoinAck }> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => resolve({ sock, res }));
      });
      sock.on('connect_error', reject);
    });

  const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  it('a stale reconnect-timeout timer must not evict a player from a same-id room created after the original room died', async () => {
    const roomId = 'STALE_TIMER_ROOM';

    const { sock: alice } = await connectAndJoin(roomId, 'Alice', 'dev-stale-host');
    const { sock: bob } = await connectAndJoin(roomId, 'Bob', 'dev-stale-bob');

    // Shrink the kick timer well below the validator's >=10s floor — this
    // bypasses the client-facing updateConfig/joinRoom validation (which only
    // guards those entry points), mutating server state directly the same way
    // other tests in this file seed rooms (e.g. `disconnected = true` above).
    rooms[roomId].state.reconnectTimeout = 0.3; // 300ms

    bob.disconnect();
    await settle(50); // let the server mark Bob disconnected and arm his removal timer

    // Alice (host) explicitly leaves. Bob (the only one left) is disconnected,
    // so there is no connected player to hand the host role to — the room is
    // torn down here, but Bob's 300ms removal timer is still pending.
    alice.emit('leaveRoom');
    await settle(50);
    expect(rooms[roomId]).toBeUndefined();

    // Bob reconnects and recreates the room fresh under the same id, becoming
    // its host.
    const { sock: bob2, res: bob2Res } = await connectAndJoin(roomId, 'Bob', 'dev-stale-bob');
    expect(bob2Res.success).toBe(true);
    expect(bob2Res.isHost).toBe(true);

    // Wait past the ORIGINAL timer's deadline: reconnectTimeout=0.3s is scaled
    // by TEST_TIMER_SCALE (0.2 in tests) to a ~60ms real timer, armed ~100ms
    // before bob2's join — 150ms is a comfortable margin past that.
    await settle(150);

    // If deleteRoom hadn't cancelled the stale timer, it would fire now
    // against the NEW room (same roomId), remove Bob (the only player) from
    // it, and delete it out from under him.
    expect(rooms[roomId]).toBeDefined();
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Bob']);

    bob2.disconnect();
  });
});

describe('emoji reactions', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];

  interface JoinAck { success: boolean; error?: string }

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
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => {
          if (!res.success) return reject(new Error(res.error));
          resolve(sock);
        });
      });
      sock.on('connect_error', reject);
    });

  // Reaction cooldown/whitelist checks are synchronous — no async I/O — so a
  // short margin is enough to prove a reaction was dropped.
  const settle = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

  it('broadcasts a whitelisted reaction to everyone in the room, with sender identity attached', async () => {
    const alice = await connectAndJoin('REACT_ROOM_A', 'Alice', 'dev-react-1');
    const bob = await connectAndJoin('REACT_ROOM_A', 'Bob', 'dev-react-2');

    const received = new Promise<{ emoji: string; senderName: string; senderColor: string }>(resolve =>
      bob.on('playerReaction', resolve)
    );

    alice.emit('sendReaction', { emoji: '🔥' });

    const payload = await received;
    expect(payload.emoji).toBe('🔥');
    expect(payload.senderName).toBe('Alice');
    expect(payload.senderColor).toBe('#ff0000');
  });

  it('rejects an emoji outside the fixed whitelist (no broadcast)', async () => {
    const alice = await connectAndJoin('REACT_ROOM_B', 'Alice', 'dev-react-3');
    const bob = await connectAndJoin('REACT_ROOM_B', 'Bob', 'dev-react-4');

    let received = false;
    bob.on('playerReaction', () => { received = true; });

    alice.emit('sendReaction', { emoji: '<script>alert(1)</script>' });
    await settle();

    expect(received).toBe(false);
  });

  it('does nothing for a socket that has not joined any room', async () => {
    const rogue = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    sockets.push(rogue);
    await new Promise<void>(resolve => rogue.on('connect', () => resolve()));

    let threw = false;
    rogue.on('connect_error', () => { threw = true; });
    rogue.emit('sendReaction', { emoji: '❤️' });
    await settle();

    expect(threw).toBe(false);
  });

  it('broadcasts at most one reaction per second per connection', async () => {
    const alice = await connectAndJoin('REACT_ROOM_C', 'Alice', 'dev-react-5');
    const bob = await connectAndJoin('REACT_ROOM_C', 'Bob', 'dev-react-6');

    let received = 0;
    bob.on('playerReaction', () => { received += 1; });

    // Three rapid-fire reactions well inside one cooldown window — only the
    // first may go out.
    alice.emit('sendReaction', { emoji: '🔥' });
    alice.emit('sendReaction', { emoji: '❤️' });
    alice.emit('sendReaction', { emoji: '🔥' });
    await settle();

    expect(received).toBe(1);
  });
});

describe('game clock (gameTimeInSeconds / gameActualStartTime)', () => {
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
    const s1 = await connectAndJoin(roomId, 'Alice', 'dev-gtm-a');

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
    const s1 = await connectAndJoin(roomId, 'Alice', 'dev-gtes-a');

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
    const s1 = await connectAndJoin(roomId, 'Alice', 'dev-gtr2-a'); // host
    const s2 = await connectAndJoin(roomId, 'Bob', 'dev-gtr2-b'); // observer, reconnects

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

    const s2New = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    sockets.push(s2New);
    const rejoinedPlaying = new Promise<{ gameTimeInSeconds: number }>(resolve => {
      s2New.on('gameState', (state) => { if (state.status === 'playing') resolve(state); });
    });
    s2New.on('connect', () => {
      s2New.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-gtr2-b', color: '#00ff00' }, () => {});
    });

    const newState = await rejoinedPlaying;
    // Server-calculated time should be >= what it was at disconnect.
    expect(newState.gameTimeInSeconds).toBeGreaterThanOrEqual(s2GameTimeAtDisconnect);
    // Should not be the stale client value (e.g. 0 from initial push or 999).
    expect(newState.gameTimeInSeconds).toBeLessThan(10);
  });

  it('gameActualStartTime is preserved across turn/card changes (not reset on subsequent pushState)', async () => {
    const roomId = 'GAME_TIME_PERSIST';
    const s1 = await connectAndJoin(roomId, 'Alice', 'dev-gtp-a');

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

describe('stats submissions require a finished game', () => {
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

  beforeEach(() => {
    mockedUpdateDeviceStats.mockReset();
    mockedUpdateGlobalStats.mockReset();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
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

  // The finished gate is a synchronous check ahead of any DB call — a short
  // margin is enough to prove the write never happened.
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 100));

  it('ignores endGameStats while the game has not finished (e.g. straight from the lobby)', async () => {
    mockedUpdateDeviceStats.mockResolvedValue(true);
    const sock = await connectAndJoin('STATS_UNFINISHED_DEV', 'Alice', 'dev-unfinished-1');

    sock.emit('endGameStats', { deviceId: 'dev-unfinished-1', stats: { gamesPlayed: 1, wins: 1 } });
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
    const sock = await connectAndJoin('STATS_UNFINISHED_GLOBAL', 'Alice', 'dev-unfinished-2');

    sock.emit('submitGlobalStats', { roomId: 'STATS_UNFINISHED_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();

    expect(mockedUpdateGlobalStats).not.toHaveBeenCalled();
    rooms['STATS_UNFINISHED_GLOBAL'].state.finished = true;
    sock.emit('submitGlobalStats', { roomId: 'STATS_UNFINISHED_GLOBAL', payload: { gamesPlayed: 1 } });
    await settle();
    expect(mockedUpdateGlobalStats).toHaveBeenCalledTimes(1);
  });
});

describe('room-count cap (MAX_ROOMS)', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];
  const seededRoomIds: string[] = [];

  interface JoinAck { success: boolean; error?: string }

  beforeAll(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;

    // Seeded directly (same pattern as the MAX_PLAYERS_PER_ROOM tests) —
    // this is about the cap check, not about 500 real join round-trips.
    // `rooms` is module state shared with other describes in this file, so
    // top up to exactly MAX_ROOMS and remove the seeds again in afterAll.
    while (Object.keys(rooms).length < MAX_ROOMS) {
      const id = `CAP_FILLER_${seededRoomIds.length}`;
      rooms[id] = createRoom(`sock-cap-filler-${seededRoomIds.length}`);
      seededRoomIds.push(id);
    }
  });

  afterAll(async () => {
    sockets.forEach(s => s.disconnect());
    seededRoomIds.forEach(id => deleteRoom(id));
    await ioServer.close();
  });

  const connectAndJoin = (roomId: string, name: string, deviceId: string): Promise<JoinAck> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      sockets.push(sock);
      sock.on('connect', () => {
        sock.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => resolve(res));
      });
      sock.on('connect_error', reject);
    });

  it('refuses to CREATE a new room once MAX_ROOMS exist', async () => {
    const res = await connectAndJoin('CAP_ONE_TOO_MANY', 'Alice', 'dev-cap-overflow');

    expect(res.success).toBe(false);
    expect(res.error).toBe('Server is full. Try again later.');
    expect(rooms['CAP_ONE_TOO_MANY']).toBeUndefined();
  });

  it('still allows joining an EXISTING room at the cap', async () => {
    const res = await connectAndJoin('CAP_FILLER_1', 'Bob', 'dev-cap-join-existing');

    expect(res.success).toBe(true);
    expect(rooms['CAP_FILLER_1'].state.players.map(p => p.name)).toEqual(['Bob']);
  });
});

describe('per-IP connection rate limiting', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let port: number;
  const sockets: ClientSocket[] = [];
  let envBefore: string | undefined;

  beforeAll(async () => {
    // Read once inside registerSocketHandlers — must be set BEFORE it runs.
    // Every connection in this suite arrives from 127.0.0.1, i.e. one key.
    envBefore = process.env.SOCKET_CONN_LIMIT_MAX;
    process.env.SOCKET_CONN_LIMIT_MAX = '2';
    httpServer = createServer();
    ioServer = new Server(httpServer);
    registerSocketHandlers(ioServer);
    await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.SOCKET_CONN_LIMIT_MAX;
    else process.env.SOCKET_CONN_LIMIT_MAX = envBefore;
    sockets.forEach(s => s.disconnect());
    await ioServer.close();
  });

  const connect = (): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
      sockets.push(sock);
      sock.on('connect', () => resolve(sock));
      sock.on('connect_error', reject);
    });

  it('rejects connections from one address past the cap — reconnecting cannot reset per-connection event limits for free', async () => {
    await connect();
    await connect();

    // Third connection in the same window from the same address must be
    // refused at the middleware, before any event handler is registered.
    await expect(connect()).rejects.toThrow('Too many connections');
  });
});
