/**
 * @vitest-environment node
 *
 * In-process socket suites for the room lifecycle: join races, membership and
 * kicks, the capacity caps, device exclusivity and stale reconnect timers.
 * Split out of socketHandlers.test.ts along the handler-module lines; the
 * database module is mocked so a join's stats fetch can be held open — the
 * lever every race test here leans on (see socketTestHarness.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { getDeviceStats } from './database';
import { startInProcessServer, emitJoin, waitFor, settle, type InProcessServer, type JoinAck } from './socketTestHarness';
import { rooms, createRoom, deleteRoom, MAX_PLAYERS_PER_ROOM, MAX_ROOMS } from './rooms';
import { MIN_ENABLED_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import type { ServerPlayer } from './roomTypes';

const mockedGetDeviceStats = vi.mocked(getDeviceStats);

describe('joinRoom await-window races (BUG-3)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  beforeEach(() => {
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  it('seats a device in at most one room when two fresh joins interleave at the stats fetch', async () => {
    // Hold BOTH joins' getDeviceStats calls open simultaneously, so each
    // one's membership checks would run against a registry the other hasn't
    // written to yet if any check-then-mutate spanned the await. Each join
    // fetches both rulesets' streaks (two calls), hence 4 pending resolvers.
    const releases: Array<() => void> = [];
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { releases.push(() => resolve(null)); }),
    );

    const [sockA, sockB] = await Promise.all([server.connect(), server.connect()]);
    const ackA = emitJoin(sockA, 'RACE_DEVICE_A', 'Alice', 'dev-race-shared');
    const ackB = emitJoin(sockB, 'RACE_DEVICE_B', 'Alice', 'dev-race-shared');

    await waitFor(() => releases.length === 4);
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
    const sockA = await server.connect();
    const first = await emitJoin(sockA, 'RACE_TEARDOWN', 'Alice', 'dev-race-teardown');
    expect(first.success).toBe(true);

    // Simulated reload: a second socket rejoins the same seat, with its stats
    // fetches (one per ruleset) held open. While they are pending, the room is
    // torn down — the same effect a reconnect-timeout timer firing has.
    const releases: Array<() => void> = [];
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { releases.push(() => resolve(null)); }),
    );
    const sockB = await server.connect();
    const ackPromise = emitJoin(sockB, 'RACE_TEARDOWN', 'Alice', 'dev-race-teardown');
    await waitFor(() => releases.length === 2);

    deleteRoom('RACE_TEARDOWN');
    releases.forEach(release => release());

    const ack = await ackPromise;

    // Success must mean actually seated in a live room — pre-fix, the handler
    // mutated the deleted room object, acked success, and left the registry
    // empty (the client believed it was in a room the server didn't have).
    expect(ack.success).toBe(true);
    expect(rooms['RACE_TEARDOWN']?.state.players.some(p => p.deviceId === 'dev-race-teardown')).toBe(true);
  });
});

describe('joinRoom race window (SERVER-SH-3)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
    mockedGetDeviceStats.mockReset();
    mockedGetDeviceStats.mockResolvedValue(null);
  });

  it('never lets a joining socket receive a room broadcast before it is in room.state.players', async () => {
    // getDeviceStats is the awaited call that used to sit between socket.join()
    // and room.state.players.push() — hold it open here to widen that window
    // as much as possible, so a lingering race would be very likely to show
    // up. A join now fetches both rulesets' streaks, so each one parks TWO
    // resolvers here.
    let resolvers: Array<() => void> = [];
    mockedGetDeviceStats.mockImplementation(
      () => new Promise(resolve => { resolvers.push(() => resolve(null)); }),
    );
    const waitForPendingStatsCall = (): Promise<void> => new Promise(resolve => {
      const check = (): void => { if (resolvers.length >= 2) resolve(); else setTimeout(check, 10); };
      check();
    });
    const releasePendingStatsCalls = (): void => {
      resolvers.forEach(release => release());
      resolvers = [];
    };

    const hostClient = await server.connect();
    const hostJoinPromise = emitJoin(hostClient, 'RACE_ROOM', 'Host', 'dev-race-host').then(res => {
      if (!res.success) throw new Error(res.error);
      return res;
    });
    // The host's own join also awaits getDeviceStats — let it resolve so only
    // the joining client's calls are left hanging below.
    await waitForPendingStatsCall();
    releasePendingStatsCalls();
    await hostJoinPromise;

    const receivedBeforeJoin: unknown[] = [];
    const joiningClient = await server.connect();
    joiningClient.on('gameState', (state) => receivedBeforeJoin.push(state));

    const joinPromise = emitJoin(joiningClient, 'RACE_ROOM', 'Joiner', 'dev-race-joiner', '#00ff00');

    // Wait until the joining client's getDeviceStats call is actually pending.
    await waitForPendingStatsCall();

    // While the joiner's join is still pending, the host triggers a broadcast.
    // Pre-fix, the joiner's socket had already called socket.join(roomId) at
    // this point (before its own await), so it would receive this and see a
    // roster missing itself. Post-fix, it hasn't joined the Socket.IO room
    // yet, so it must receive nothing here.
    hostClient.emit('updateConfig', { roomId: 'RACE_ROOM', winningScore: 5000 });
    await settle(60);
    expect(receivedBeforeJoin).toEqual([]);

    // Now let the joiner's own getDeviceStats calls resolve and complete the join.
    releasePendingStatsCalls();
    const joinResult = await joinPromise;
    expect(joinResult.success).toBe(true);

    // The very first broadcast the joiner receives (its own join's
    // emitRoomState) must already include itself.
    await settle(60);
    const firstState = receivedBeforeJoin[0] as { players: { name: string }[] } | undefined;
    expect(firstState?.players.some(p => p.name === 'Joiner')).toBe(true);
  });
});

describe('room membership (kick host migration, mid-game rename guard)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('reassigns the host when the host kicks their own socket', async () => {
    // Only a modified host client can self-kick, but the room must not be
    // left with a host id that is no longer seated — no config, kick or
    // restart would work for anyone until the room died.
    const host = await server.connectAndJoin('SELF_KICK_ROOM', 'Host', 'dev-sk-h');
    const peer = await server.connectAndJoin('SELF_KICK_ROOM', 'Peer', 'dev-sk-p');

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

  it('deletes the room when the host self-kicks and every remaining seat is a timerless ghost', async () => {
    // reconnectTimeout=0 means the server never arms a reconnect timer, so a
    // dropped player keeps their seat marked disconnected indefinitely. Kicking
    // the last connected socket out of such a room leaves nothing behind that
    // could ever free it: no socket left to disconnect, no timer left to fire,
    // and a host id pointing at a dead socket. The room leaks for the process's
    // lifetime. handlePlayerLeave's explicit-leave path already guards exactly
    // this (socketRoomHandlers.ts, "all remaining players are disconnected with
    // no reconnect timers"); the kick path did not.
    const roomId = 'SELF_KICK_GHOSTS';
    const host = await server.connectAndJoin(roomId, 'Host', 'dev-skg-h');
    const peer = await server.connectAndJoin(roomId, 'Peer', 'dev-skg-p');

    host.emit('updateConfig', { roomId, reconnectTimeout: 0 });
    await waitFor(() => rooms[roomId]?.state.reconnectTimeout === 0);

    peer.disconnect();
    await waitFor(() => rooms[roomId]?.state.players.some(p => p.name === 'Peer' && p.disconnected) === true);
    // The premise of the leak: the ghost seat has no timer pending, so nothing
    // scheduled will ever revisit this room.
    expect(Object.keys(rooms[roomId].disconnectTimers)).toEqual([]);

    host.emit('kickPlayer', host.id);

    await waitFor(() => rooms[roomId] === undefined);
  });

  it('deletes the room when a draining reconnect timer leaves only timerless ghosts behind', async () => {
    // The kick-time guard above cannot see this coming: at the moment of the
    // kick a reconnect timer is still pending, so the room is legitimately kept
    // alive for the player it belongs to. When that timer later fires and takes
    // the last timed seat with it, what remains is the very room the guard
    // exists to delete — and the timer callback only checked for an EMPTY
    // roster, so the room survived with nothing left that could ever free it.
    const roomId = 'TIMER_DRAIN_GHOSTS';
    // The smallest value the config accepts other than 0 (0 arms no timer at
    // all, which is the case the kick-time guard already covers). Its deadline
    // is never reached — see the manual fire below — so the value only has to
    // be one the server will arm a timer for.
    const RECONNECT_TIMEOUT_SECS = MIN_ENABLED_RECONNECT_TIMEOUT;
    const TIMED_DEVICE_ID = 'dev-tdg-t';

    const host = await server.connectAndJoin(roomId, 'Host', 'dev-tdg-h');
    const timed = await server.connectAndJoin(roomId, 'Timed', TIMED_DEVICE_ID);
    const ghost = await server.connectAndJoin(roomId, 'Ghost', 'dev-tdg-g');

    host.emit('updateConfig', { roomId, reconnectTimeout: RECONNECT_TIMEOUT_SECS });
    await waitFor(() => rooms[roomId]?.state.reconnectTimeout === RECONNECT_TIMEOUT_SECS);

    // Drops with a timer armed — this is what defers the kick-time guard.
    timed.disconnect();
    await waitFor(() => Object.keys(rooms[roomId]?.disconnectTimers ?? {}).length === 1);

    // Turning the timeout off does NOT retract the timer already armed above,
    // so the room now holds one timed seat and one that will never be freed.
    host.emit('updateConfig', { roomId, reconnectTimeout: 0 });
    await waitFor(() => rooms[roomId]?.state.reconnectTimeout === 0);

    ghost.disconnect();
    await waitFor(() => rooms[roomId]?.state.players.some(p => p.name === 'Ghost' && p.disconnected) === true);
    expect(Object.keys(rooms[roomId].disconnectTimers)).toEqual([TIMED_DEVICE_ID]);

    host.emit('kickPlayer', host.id);

    // Correctly kept: the timed seat still has a reconnect window to honour.
    await waitFor(() => rooms[roomId]?.state.players.length === 2);
    expect(rooms[roomId].state.players.map(p => p.name)).toEqual(['Timed', 'Ghost']);

    // Fire the pending timer on demand rather than sleeping out its deadline.
    // Waiting for it real-time cost two seconds AND raced: every step above has
    // to land while the timer is still pending, so the deadline was simply
    // sized to be longer than they take — true until a loaded machine says
    // otherwise. Reaching for the handle removes both problems. It runs the
    // exact closure the runtime would have run; only the scheduling is skipped,
    // and scheduling is not what is under test.
    //
    // Captured BEFORE clearing: Node nulls a handle's callback when it is
    // cleared. Clearing at all is what stops the real deadline firing it a
    // second time, later, against an already-deleted room.
    const pending = rooms[roomId].disconnectTimers[TIMED_DEVICE_ID] as unknown as { _onTimeout?: () => void };
    const fireTimerNow = pending._onTimeout;
    // Guards the reach-around itself: if a Node upgrade renames this, the test
    // must say so rather than quietly stop exercising the drain at all.
    expect(typeof fireTimerNow).toBe('function');
    clearTimeout(rooms[roomId].disconnectTimers[TIMED_DEVICE_ID]);

    fireTimerNow?.();

    // Synchronous — the callback runs to completion above, so there is nothing
    // left to wait for.
    expect(rooms[roomId]).toBeUndefined();
  });

  it('kicking a non-host player leaves the host unchanged', async () => {
    const host = await server.connectAndJoin('NORMAL_KICK_ROOM', 'Host', 'dev-nk-h');
    const peer = await server.connectAndJoin('NORMAL_KICK_ROOM', 'Peer', 'dev-nk-p');

    const peerKicked = new Promise<void>(resolve => peer.on('kicked', () => resolve()));
    host.emit('kickPlayer', peer.id);
    await peerKicked;

    expect(rooms['NORMAL_KICK_ROOM'].host).toBe(host.id);
    expect(rooms['NORMAL_KICK_ROOM'].state.players.map(p => p.name)).toEqual(['Host']);
  });

  it('ignores a kickPlayer payload that is not a string', async () => {
    const host = await server.connectAndJoin('MALFORMED_KICK_ROOM', 'Host', 'dev-mk-h');
    const peer = await server.connectAndJoin('MALFORMED_KICK_ROOM', 'Peer', 'dev-mk-p');

    const peerKicked = vi.fn();
    peer.on('kicked', peerKicked);

    host.emit('kickPlayer', { socketId: peer.id });
    host.emit('kickPlayer', null);
    host.emit('kickPlayer', 42);

    // Give the malformed emits a tick to be (mis)handled, then confirm a
    // real kick still works — proving the handler didn't crash or leave the
    // room in a bad state.
    await settle(50);
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
    const host = await server.connectAndJoin('RENAME_GAME_ROOM', 'Alice', 'dev-rn-1');
    host.emit('pushState', { roomId: 'RENAME_GAME_ROOM', newState: { status: 'playing', currentPlayerIndex: 0 } });
    await waitFor(() => rooms['RENAME_GAME_ROOM']?.state.status === 'playing');

    // Same device takes over its seat from a new socket, but with a new name.
    const { res } = await server.joinRaw('RENAME_GAME_ROOM', 'Impostor', 'dev-rn-1');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Alice');
    expect(rooms['RENAME_GAME_ROOM'].state.players.map(p => p.name)).toEqual(['Alice']);
  });

  it('a lobby rejoin may still rename freely', async () => {
    await server.connectAndJoin('RENAME_LOBBY_ROOM', 'Bob', 'dev-rn-2');

    const { res } = await server.joinRaw('RENAME_LOBBY_ROOM', 'Bobby', 'dev-rn-2');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Bobby');
    expect(rooms['RENAME_LOBBY_ROOM'].state.players.map(p => p.name)).toEqual(['Bobby']);
  });

  it('a lobby rename to a name held by another player is still rejected', async () => {
    await server.connectAndJoin('RENAME_CONFLICT_ROOM', 'Carol', 'dev-rn-3');
    await server.connectAndJoin('RENAME_CONFLICT_ROOM', 'Dave', 'dev-rn-4');

    const { res } = await server.joinRaw('RENAME_CONFLICT_ROOM', 'carol', 'dev-rn-4');

    expect(res.success).toBe(false);
    expect(res.error).toBe('Username already exists in this room');
    expect(rooms['RENAME_CONFLICT_ROOM'].state.players.map(p => p.name).sort()).toEqual(['Carol', 'Dave']);
  });

  it('handles getDeviceStats failure gracefully during joinRoom', async () => {
    mockedGetDeviceStats.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res } = await server.joinRaw('DB_FAIL_ROOM', 'Eve', 'dev-fail-1');

    expect(res.success).toBe(true);
    expect(res.name).toBe('Eve');
    expect(rooms['DB_FAIL_ROOM'].state.players[0].winStreak).toBe(0);
  });
});

describe('room capacity cap', () => {
  let server: InProcessServer;

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
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects a fresh join once the room already holds MAX_PLAYERS_PER_ROOM players', async () => {
    const roomId = 'FULL_ROOM';
    // Seeded directly rather than via 100 real joinRoom round-trips — this test
    // is about the cap check itself, not about exercising 100 real sockets.
    rooms[roomId] = createRoom('fake-host-socket');
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      rooms[roomId].state.players.push(makeFillerPlayer('full', i));
    }

    const { res } = await server.joinRaw(roomId, 'OneTooMany', 'dev-overflow');

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

    const { res } = await server.joinRaw(roomId, 'Filler0', 'dev-filler-reconnect-0');

    expect(res.success).toBe(true);
    expect(rooms[roomId].state.players.length).toBe(MAX_PLAYERS_PER_ROOM);
  });
});

describe('device room exclusivity (one device, one room)', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects a second room for a deviceId already seated (connected) in another room, via a different socket', async () => {
    await server.connectAndJoin('EXCL_ROOM_A', 'Alice', 'dev-excl-1');

    // A second tab/socket from the same device (e.g. same browser localStorage)
    // tries to spin up a different room while the first seat is still live.
    const { res } = await server.joinRaw('EXCL_ROOM_B', 'Alice', 'dev-excl-1');

    expect(res.success).toBe(false);
    expect(res.error).toBe('This device is already in another room. Leave it before joining a new one.');
    // Must not create an empty room as a side effect of the rejected attempt.
    expect(rooms['EXCL_ROOM_B']).toBeUndefined();
  });

  it('still blocks a second room while the first seat is merely disconnected (not yet timed out)', async () => {
    const { sock: s1 } = await server.joinRaw('EXCL_ROOM_C', 'Bob', 'dev-excl-2');
    s1.disconnect();
    await settle(); // let the server mark the seat disconnected

    const { res } = await server.joinRaw('EXCL_ROOM_D', 'Bob', 'dev-excl-2');

    expect(res.success).toBe(false);
    expect(res.error).toBe('This device is already in another room. Leave it before joining a new one.');
  });

  it('allows a new room once the device has explicitly left its previous one', async () => {
    const { sock: s1 } = await server.joinRaw('EXCL_ROOM_E', 'Carol', 'dev-excl-3');
    s1.emit('leaveRoom');
    await settle();

    const { res } = await server.joinRaw('EXCL_ROOM_F', 'Carol', 'dev-excl-3');

    expect(res.success).toBe(true);
  });

  it('does not block a reconnect/rejoin into the SAME room the device is already seated in', async () => {
    await server.connectAndJoin('EXCL_ROOM_G', 'Dave', 'dev-excl-4');

    // e.g. a page reload issuing a brand-new socket connection for the same room.
    const { res } = await server.joinRaw('EXCL_ROOM_G', 'Dave', 'dev-excl-4');

    expect(res.success).toBe(true);
    expect(rooms['EXCL_ROOM_G'].state.players.length).toBe(1);
  });
});

describe('room deletion clears pending disconnect timers', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('a stale reconnect-timeout timer must not evict a player from a same-id room created after the original room died', async () => {
    const roomId = 'STALE_TIMER_ROOM';

    const { sock: alice } = await server.joinRaw(roomId, 'Alice', 'dev-stale-host');
    const { sock: bob } = await server.joinRaw(roomId, 'Bob', 'dev-stale-bob');

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
    const { sock: bob2, res: bob2Res } = await server.joinRaw(roomId, 'Bob', 'dev-stale-bob');
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

describe('room-count cap (MAX_ROOMS)', () => {
  let server: InProcessServer;
  const seededRoomIds: string[] = [];

  beforeAll(async () => {
    server = await startInProcessServer();

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
    seededRoomIds.forEach(id => deleteRoom(id));
    await server.close();
  });

  const joinAck = async (roomId: string, name: string, deviceId: string): Promise<JoinAck> =>
    (await server.joinRaw(roomId, name, deviceId)).res;

  it('refuses to CREATE a new room once MAX_ROOMS exist', async () => {
    const res = await joinAck('CAP_ONE_TOO_MANY', 'Alice', 'dev-cap-overflow');

    expect(res.success).toBe(false);
    expect(res.error).toBe('Server is full. Try again later.');
    expect(rooms['CAP_ONE_TOO_MANY']).toBeUndefined();
  });

  it('still allows joining an EXISTING room at the cap', async () => {
    const res = await joinAck('CAP_FILLER_1', 'Bob', 'dev-cap-join-existing');

    expect(res.success).toBe(true);
    expect(rooms['CAP_FILLER_1'].state.players.map(p => p.name)).toEqual(['Bob']);
  });
});
