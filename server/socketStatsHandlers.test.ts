/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerStatsHandlers } from './socketStatsHandlers';
import { makeFakeSocket, makeFakeIo, makeServerPlayer } from './socketTestHarness';
import { rooms, createRoom, deleteRoom, emitRoomState } from './rooms';
import { summarizeActivity } from './activity';
import { nonNull } from '../src/testing/factories';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));
import { getDeviceStats, updateDeviceStats } from './database';

// This file's players default to position: 1 (rather than makeServerPlayer's
// own default of 0) — kept as an explicit override below so converting to
// the shared factory doesn't change what these fixtures build.
const makePlayer = (name: string, socketId: string, deviceId: string) =>
  makeServerPlayer(name, { socketId, deviceId, position: 1 });

// Long enough that the staged reconnect timer is still pending for the whole
// test (deleteRoom clears it afterwards) — only its EXISTENCE is read.
const RECONNECT_TIMER_MS = 60_000;

describe('endGameStats win-streak refresh', () => {
  const roomId = 'STREAK-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset();
  });

  it('writes the refreshed streak to the CURRENT seat, not a pre-await snapshot', async () => {
    // Between the two awaits a players-carrying push (e.g. the host's Play
    // Again) can rebuild every roster entry — writing to the object resolved
    // before the awaits would update a detached copy and broadcast the very
    // stale streak this refresh exists to fix.
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    // The interleaved push, simulated at the first await: every roster entry
    // is replaced by a copy.
    vi.mocked(updateDeviceStats).mockImplementation(async () => {
      rooms[roomId].state.players = rooms[roomId].state.players.map(p => ({ ...p }));
      return 1;
    });
    vi.mocked(getDeviceStats).mockResolvedValue({ currentWinStreak: 5 } as never);

    const { io } = makeFakeIo();
    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io, socket: fake.socket, session: { roomId, username: 'Alice' } });

    fake.handlers['endGameStats']({ deviceId: 'dev-alice', stats: { gamesPlayed: 1, wins: 1 } });

    await vi.waitFor(() => expect(getDeviceStats).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(rooms[roomId].state.players[0].winStreak).toBe(5));
  });
});

describe("who won is the server's call, not the submitting client's", () => {
  const roomId = 'WINNER-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  const seatBobAlone = () => {
    // Alice won on 10000; Bob lost on 4000. The room broadcasts the finish —
    // which is where the winner is frozen — and only THEN does Alice's seat go
    // (an explicit leave, or her reconnect timer draining; either splices the
    // seat, and abortGameIfLowPlayers deliberately skips a finished game).
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, winningScore: 6000,
      players: [
        { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: 10000, totalTurns: 20 },
        { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: 4000, totalTurns: 19 },
      ],
    });
    emitRoomState(makeFakeIo().io, roomId);
    rooms[roomId].state.players.splice(0, 1);
    // The leave broadcasts too, and that later broadcast must NOT re-freeze
    // the verdict over the roster it just shrank — otherwise Bob becomes the
    // leader of a table of one and the correction hands back the same wrong
    // answer it was added to prevent.
    emitRoomState(makeFakeIo().io, roomId);

    const fake = makeFakeSocket('bob-sock');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
    return fake.handlers['endGameStats'];
  };

  it('refuses the win a last-player-standing client computes for itself', async () => {
    // Bob was disconnected at the final turn, so his client's `finished` is
    // still false; auto-reconnect lands him back in the room and the incoming
    // gameState is his FIRST sight of the finish. sendOnlineStats then runs
    // getLeaders() over a roster Alice already left — so the last player
    // standing looks like the leader, and Bob's own honest client submits a
    // win. fastestWinTurns is a MIN column and the streak only ever rises, so
    // both are unremovable without editing the database.
    const endGameStats = seatBobAlone();

    await endGameStats({ deviceId: 'dev-bob', stats: {
      gamesPlayed: 1, wins: 1, totalTurns: 19,
      fastestWinTurns: 19, fastestLossTurns: null,
      totalPlayersSum: 1, mostPlayersInGame: 1,
    } });

    const written = vi.mocked(updateDeviceStats).mock.calls[0]?.[1];
    expect(written, 'the submission is still recorded — only the verdict is corrected').toBeDefined();
    expect(written!.wins, 'Bob did not win').toBe(0);
    expect(written!.fastestWinTurns, 'a loss sets no fastest-win record').toBeNull();
    expect(written!.fastestLossTurns, 'it was a loss, in 19 turns').toBe(19);
    expect(written!.totalPlayersSum, 'two players finished this game').toBe(2);
    expect(written!.mostPlayersInGame).toBe(2);
  });

  it('still credits the real winner, and keeps their own counters', async () => {
    // The control: the same frozen verdict must confirm a genuine win, or the
    // correction above is indistinguishable from never recording one.
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, winningScore: 6000,
      players: [
        { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: 10000, totalTurns: 20 },
        { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: 4000, totalTurns: 19 },
      ],
    });
    emitRoomState(makeFakeIo().io, roomId);

    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });

    await fake.handlers['endGameStats']({ deviceId: 'dev-alice', stats: {
      gamesPlayed: 1, wins: 1, totalTurns: 20, busts: 3,
      fastestWinTurns: 20, fastestLossTurns: null, totalPlayersSum: 2, mostPlayersInGame: 2,
    } });

    const written = vi.mocked(updateDeviceStats).mock.calls[0]?.[1];
    expect(written!.wins).toBe(1);
    expect(written!.fastestWinTurns).toBe(20);
    expect(written!.fastestLossTurns).toBeNull();
    expect(written!.busts, "the player's own counters are untouched").toBe(3);
  });
});

describe('endGameStats dedup rollback', () => {
  // The per-device dedup is added BEFORE the write so a concurrent duplicate
  // can't slip through, which makes rolling it back on failure the delicate
  // part: reopen it when nothing was committed (a retry must still be able to
  // record the game), but leave it closed once the row is in — otherwise the
  // retry counts the same game twice. Hence the handler's two separate
  // catches; these pin that they stay separate.
  const roomId = 'DEDUP-ROLLBACK-ROOM';
  const deviceId = 'dev-alice';
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset();
    // Both failure paths report through console.error. Spying keeps the
    // expected noise out of the run and, more importantly, gives each test a
    // deterministic signal that the catch it cares about has actually run —
    // the handler is fire-and-forget, so there is nothing else to await.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** A room sitting on a finished default-config game, with Alice at the table. */
  const stageFinishedGame = () => {
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', deviceId)],
    });
  };

  const submitStats = () => {
    const { io } = makeFakeIo();
    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    fake.handlers['endGameStats']({ deviceId, stats: { gamesPlayed: 1, wins: 1 } });
  };

  it('keeps the dedup when only the post-write streak refresh fails', async () => {
    stageFinishedGame();
    vi.mocked(updateDeviceStats).mockResolvedValue(true);
    vi.mocked(getDeviceStats).mockRejectedValue(new Error('read failed'));

    submitStats();

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    // The device row IS committed — a rollback here would let a retry (a
    // reconnect re-firing the client's "finished just became true" path)
    // record the very same game a second time.
    expect(rooms[roomId].statsRecordedForGame.devices.has(deviceId)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('[endGameStats] streak refresh error:', expect.anything());
  });

  it('still rolls back when the write itself fails', async () => {
    stageFinishedGame();
    vi.mocked(updateDeviceStats).mockRejectedValue(new Error('write failed'));

    submitStats();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[endGameStats] error:', expect.anything()));
    // Nothing was committed, so the dedup must reopen — otherwise a transient
    // DB error would permanently swallow this game's stats.
    expect(rooms[roomId].statsRecordedForGame.devices.has(deviceId)).toBe(false);
    // And the handler must not have gone on to the refresh at all.
    expect(getDeviceStats).not.toHaveBeenCalled();
  });
});

describe('a seat that left before the finish is recorded by the server itself', () => {
  // Item A5: endGameStats only ever hears from a currently seated socket, so
  // a seat that left, was kicked, or timed out before the game's finish was
  // broadcast used to leave no trace at all — preserving its win streak,
  // hiding a fastest-loss record, and undercounting totalPlayersSum /
  // mostPlayersInGame. The server now writes that seat's row itself, the
  // moment the game's verdict is frozen (rooms.ts' rememberFinishedGame /
  // recordDepartedSeatsStats), from the roster captured when the game
  // started (see socketGameStateHandlers.ts' startRoster capture).
  const roomId = 'DEPARTED-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  /** Alice is the sole survivor at the finish; Bob left before it was broadcast. */
  const stageBobLeftBeforeFinish = () => {
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].startRoster = [
      { deviceId: 'dev-alice', name: 'Alice' },
      { deviceId: 'dev-bob', name: 'Bob' },
    ];
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [{ ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: 10000 }],
    });
  };

  it('writes a played, lost game for the departed seat — gamesPlayed 1, wins 0', () => {
    stageBobLeftBeforeFinish();

    emitRoomState(makeFakeIo().io, roomId);

    expect(updateDeviceStats).toHaveBeenCalledWith(
      'dev-bob',
      expect.objectContaining({ gamesPlayed: 1, wins: 0 }),
      'normalized',
    );
    // No fastest-loss/win record: the seat never saw the game through to the
    // end, so it earns no record — only the survivor's own submission can.
    const written = vi.mocked(updateDeviceStats).mock.calls[0][1];
    expect(written.fastestWinTurns).toBeUndefined();
    expect(written.fastestLossTurns).toBeUndefined();
  });

  it('does not touch the surviving player\'s row', () => {
    stageBobLeftBeforeFinish();

    emitRoomState(makeFakeIo().io, roomId);

    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateDeviceStats).mock.calls.every(c => c[0] !== 'dev-alice')).toBe(true);
  });

  it('counts every start-roster seat toward totalPlayersSum/mostPlayersInGame, not just survivors', () => {
    stageBobLeftBeforeFinish();

    emitRoomState(makeFakeIo().io, roomId);

    const written = vi.mocked(updateDeviceStats).mock.calls[0][1];
    expect(written.totalPlayersSum, 'two seats started the game').toBe(2);
    expect(written.mostPlayersInGame).toBe(2);
  });

  it('is idempotent across repeated broadcasts of the same finished game', () => {
    stageBobLeftBeforeFinish();

    emitRoomState(makeFakeIo().io, roomId);
    emitRoomState(makeFakeIo().io, roomId); // e.g. a spectator join re-broadcasting state

    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a later submission from the same device+game (e.g. a reconnect replaying its own submission)', async () => {
    stageBobLeftBeforeFinish();
    emitRoomState(makeFakeIo().io, roomId);
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);

    // Bob reconnects under the same deviceId (a rejoin after the timeout
    // that removed him) and his own client then submits for the same game —
    // the dedup this server write shares with endGameStats must refuse it,
    // proving the row can never be written twice.
    rooms[roomId].state.players.push(makePlayer('Bob', 'bob-sock-2', 'dev-bob'));
    const fake = makeFakeSocket('bob-sock-2');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
    await fake.handlers['endGameStats']({ deviceId: 'dev-bob', stats: { gamesPlayed: 1, wins: 1 } });

    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
  });

  it('skips a start-roster seat with no deviceId', () => {
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].startRoster = [
      { deviceId: 'dev-alice', name: 'Alice' },
      { deviceId: '', name: 'Ghost' },
    ];
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    emitRoomState(makeFakeIo().io, roomId);

    expect(updateDeviceStats).not.toHaveBeenCalled();
  });

  it('does not write anything when every start-roster seat is still present', () => {
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].startRoster = [
      { deviceId: 'dev-alice', name: 'Alice' },
      { deviceId: 'dev-bob', name: 'Bob' },
    ];
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [
        makePlayer('Alice', 'alice-sock', 'dev-alice'),
        makePlayer('Bob', 'bob-sock', 'dev-bob'),
      ],
    });

    emitRoomState(makeFakeIo().io, roomId);

    expect(updateDeviceStats).not.toHaveBeenCalled();
  });

  it('rolls back the dedup so a retry can land when the write fails', async () => {
    stageBobLeftBeforeFinish();
    vi.mocked(updateDeviceStats).mockRejectedValue(new Error('write failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitRoomState(makeFakeIo().io, roomId);

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(rooms[roomId].statsRecordedForGame.devices.has('dev-bob')).toBe(false);
    errorSpy.mockRestore();
  });

  // A seat that dropped mid-game is still IN room.state.players at the finish
  // — `disconnected: true`, waiting out its reconnect timer — so the
  // still-seated check skipped it. Its own client is offline and never
  // submits, and by the time the timer drains and splices the seat,
  // rememberFinishedGame has long since frozen the verdict and early-returns.
  // Nothing recorded that device's game, ever.
  describe('a seat that is disconnected but still seated at the finish', () => {
    /** Bob dropped mid-game and is waiting out his reconnect timer at the finish. */
    const stageBobDisconnectedAtFinish = (bobScore: number, aliceScore: number) => {
      rooms[roomId] = createRoom('alice-sock');
      rooms[roomId].startRoster = [
        { deviceId: 'dev-alice', name: 'Alice' },
        { deviceId: 'dev-bob', name: 'Bob' },
      ];
      Object.assign(rooms[roomId].state, {
        status: 'playing', finished: true, currentPlayerIndex: null, winningScore: 6000,
        players: [
          { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: aliceScore },
          { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: bobScore, disconnected: true },
        ],
      });
      // The pending reconnect timer that keeps the seat alive — and that
      // activity.ts reads as "this device can still submit".
      rooms[roomId].disconnectTimers['dev-bob'] = setTimeout(() => {}, RECONNECT_TIMER_MS);
    };

    const BOB_LOST = 4000;
    const BOB_WON = 10000;
    const ALICE_LOST = 4000;
    const ALICE_WON = 10000;

    it('records the dropped seat as a played, lost game', () => {
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);

      emitRoomState(makeFakeIo().io, roomId);

      expect(updateDeviceStats).toHaveBeenCalledWith(
        'dev-bob',
        expect.objectContaining({ gamesPlayed: 1, wins: 0, totalPlayersSum: 2, mostPlayersInGame: 2 }),
        'normalized',
      );
    });

    it('credits the dropped seat with the win when the frozen verdict says it won', () => {
      // Unlike a seat that LEFT, a disconnected one is still at the table when
      // the round ends — the game finishes regardless of who is connected, so
      // this seat can genuinely be the winner. Written from room.finishedGame,
      // exactly the way endGameStats' server-side override decides `wins`.
      stageBobDisconnectedAtFinish(BOB_WON, ALICE_LOST);

      emitRoomState(makeFakeIo().io, roomId);

      expect(updateDeviceStats).toHaveBeenCalledWith(
        'dev-bob',
        expect.objectContaining({ gamesPlayed: 1, wins: 1 }),
        'normalized',
      );
    });

    it('leaves the connected survivor to submit for herself', () => {
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);

      emitRoomState(makeFakeIo().io, roomId);

      expect(updateDeviceStats).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateDeviceStats).mock.calls.every(c => c[0] !== 'dev-alice')).toBe(true);
    });

    it('blocks the seat\'s own submission if it reconnects after all', async () => {
      // The trade this accepts: the row is already in, so the per-turn
      // counters the returning client is holding are dropped rather than
      // double-counted.
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);
      emitRoomState(makeFakeIo().io, roomId);
      expect(updateDeviceStats).toHaveBeenCalledTimes(1);

      const bobSeat = nonNull(rooms[roomId].state.players.find(p => p.deviceId === 'dev-bob'));
      bobSeat.disconnected = false;
      const fake = makeFakeSocket('bob-sock');
      registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
      await fake.handlers['endGameStats']({ deviceId: 'dev-bob', stats: { gamesPlayed: 1, wins: 1, busts: 7 } });

      expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    });

    it('stops the status line calling the game "awaiting stats" for that seat', () => {
      // activity.ts counts a disconnected seat with a pending reconnect timer
      // as one that can still submit — which held the room in `awaiting` (and
      // the console at DO NOT RESTART) for a row nothing would ever write.
      // The server's own write closes it through the shared dedup.
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);
      rooms[roomId].statsRecordedForGame.global = true;
      rooms[roomId].statsRecordedForGame.devices.add('dev-alice');

      emitRoomState(makeFakeIo().io, roomId);

      expect(summarizeActivity(rooms).awaitingStats).toBe(0);
    });
  });
});
