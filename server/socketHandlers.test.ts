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
import { rooms, createRoom, MAX_PLAYERS_PER_ROOM } from './rooms';
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

  it('endGameStats: refreshes the winning player\'s in-room winStreak and broadcasts it, instead of leaving it stale until the next join', async () => {
    mockedUpdateDeviceStats.mockResolvedValue(true);
    // Player joined with no prior streak...
    mockedGetDeviceStats.mockResolvedValueOnce(null);
    client = await connectAndJoin('STATS_STREAK_ROOM', 'Alice', 'dev-streak-1');

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

    // Wait past the ORIGINAL timer's deadline (armed ~100ms before bob2's
    // join, well under the 300ms duration) with a comfortable margin.
    await settle(500);

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

  const settle = (ms = 150): Promise<void> => new Promise(r => setTimeout(r, ms));

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
    rogue.emit('sendReaction', { emoji: '👍' });
    await settle();

    expect(threw).toBe(false);
  });
});
