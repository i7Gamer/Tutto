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
import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';

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

  it('never counts the game twice when the same device submits for it later', async () => {
    stageBobLeftBeforeFinish();
    emitRoomState(makeFakeIo().io, roomId);
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);

    // Bob rejoins under the same deviceId (after the timeout that removed
    // him) and his own client then submits for the same game. The row this
    // server write left behind is verdict-only, so the submission is merged
    // into it rather than refused — but the game is already counted, and the
    // merge may not count it again (see the merge suite below).
    rooms[roomId].state.players.push(makePlayer('Bob', 'bob-sock-2', 'dev-bob'));
    const fake = makeFakeSocket('bob-sock-2');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
    await fake.handlers['endGameStats']({ deviceId: 'dev-bob', stats: { gamesPlayed: 1, wins: 1 } });

    const gamesCounted = vi.mocked(updateDeviceStats).mock.calls
      .filter(c => c[0] === 'dev-bob')
      .reduce((sum, c) => sum + Number(c[1].gamesPlayed ?? 0), 0);
    expect(gamesCounted, 'one game, however many writes it took').toBe(1);
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
    // Per-turn counters only the dropped seat's own client ever held.
    const BOB_BUSTS_HELD = 7;
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

    it('takes the seat\'s own counters if it reconnects after all', async () => {
      // The row already in is verdict-only, so the per-turn counters the
      // returning client is holding are merged into it — see the merge suite
      // below for what such a write may and may not repeat.
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);
      emitRoomState(makeFakeIo().io, roomId);
      expect(updateDeviceStats).toHaveBeenCalledTimes(1);

      const bobSeat = nonNull(rooms[roomId].state.players.find(p => p.deviceId === 'dev-bob'));
      bobSeat.disconnected = false;
      const fake = makeFakeSocket('bob-sock');
      registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
      await fake.handlers['endGameStats']({ deviceId: 'dev-bob', stats: { gamesPlayed: 1, wins: 1, busts: BOB_BUSTS_HELD } });

      expect(updateDeviceStats).toHaveBeenCalledTimes(2);
      expect(vi.mocked(updateDeviceStats).mock.calls[1][1].busts, 'the counters no server write could know')
        .toBe(BOB_BUSTS_HELD);
    });

    it('stops the status line calling the game "awaiting stats" for that seat', () => {
      // activity.ts counts a disconnected seat with a pending reconnect timer
      // as one that can still submit — which held the room in `awaiting` (and
      // the console at DO NOT RESTART) for a row nothing would ever write.
      // The server's own write closes it through the shared dedup.
      stageBobDisconnectedAtFinish(BOB_LOST, ALICE_WON);
      rooms[roomId].statsRecordedForGame.global = true;
      rooms[roomId].statsRecordedForGame.devices.set('dev-alice', 'full');

      emitRoomState(makeFakeIo().io, roomId);

      expect(summarizeActivity(rooms).awaitingStats).toBe(0);
    });
  });
});

describe('the global row counts the same players the device rows do', () => {
  // endGameStats takes totalPlayersSum/mostPlayersInGame from the frozen
  // verdict, because the submitting client's roster is missing anyone who
  // left. submitGlobalStats overrode only isDefaultGame, so the GLOBAL row
  // still took both from the host's snapshot — and the two halves of the same
  // game disagreed about how many people played it.
  const roomId = 'GLOBAL-COUNT-ROOM';
  const SEATS_AT_KICKOFF = 3;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
    vi.mocked(updateGlobalStats).mockReset().mockResolvedValue(1);
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  it('takes the player count from the frozen verdict, not the host snapshot', async () => {
    // Three seats started; Carol left before the finish was broadcast, so the
    // host's own end-screen roster — and the payload built from it — knows
    // only two.
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].startRoster = [
      { deviceId: 'dev-alice', name: 'Alice' },
      { deviceId: 'dev-bob', name: 'Bob' },
      { deviceId: 'dev-carol', name: 'Carol' },
    ];
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, winningScore: 6000,
      players: [
        { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: 10000 },
        { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: 4000 },
      ],
    });
    emitRoomState(makeFakeIo().io, roomId);

    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    await fake.handlers['submitGlobalStats']({
      roomId,
      payload: { totalGamesPlayed: 1, totalPlayersSum: 2, mostPlayersInGame: 2 },
    });

    const written = vi.mocked(updateGlobalStats).mock.calls[0]?.[0];
    expect(written, 'the game is still recorded').toBeDefined();
    expect(written!.totalPlayersSum, 'three seats started this game').toBe(SEATS_AT_KICKOFF);
    expect(written!.mostPlayersInGame).toBe(SEATS_AT_KICKOFF);
    expect(written!.isDefaultGame, 'the existing override is untouched').toBe(true);
  });

  it('leaves the payload alone when the room froze no verdict to correct from', async () => {
    // A room seeded without a start roster still freezes a verdict, but one
    // whose finishedGame is missing entirely (nothing broadcast the finish)
    // has no count to substitute — the payload is the only answer there is.
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    await fake.handlers['submitGlobalStats']({
      roomId,
      payload: { totalGamesPlayed: 1, totalPlayersSum: 2, mostPlayersInGame: 2 },
    });

    const written = vi.mocked(updateGlobalStats).mock.calls[0]?.[0];
    expect(written!.totalPlayersSum).toBe(2);
    expect(written!.mostPlayersInGame).toBe(2);
  });
});

describe("a returning client merges into the server's verdict-only row", () => {
  // Item W7-1: the server writes a VERDICT-ONLY row (gamesPlayed 1, wins from
  // the frozen verdict, the player-count pair — and nothing else) for a seat
  // that is gone or merely disconnected when the finish is broadcast. That
  // write marks the shared per-game dedup, which used to make the device's
  // OWN submission a duplicate: a player who dropped right at the finish and
  // reconnected seconds later lost that game's busts, tuttos, card counters
  // and records for good. Such a submission is now accepted as a MERGE —
  // everything the verdict row could not know, with the game itself not
  // counted a second time and the streak left exactly where the verdict put
  // it.
  const roomId = 'MERGE-ROOM';
  const BOB_LOST = 4000;
  const ALICE_WON = 10000;
  const BOB_TURNS = 19;
  const BOB_BUSTS = 7;
  const BOB_TUTTOS = 3;
  const BOB_MOST_CARDS = 6;
  const SEATS_AT_KICKOFF = 2;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  /** Bob dropped mid-game and is waiting out his reconnect timer at the finish. */
  const stageBobDroppedAtFinish = () => {
    rooms[roomId] = createRoom('alice-sock');
    rooms[roomId].startRoster = [
      { deviceId: 'dev-alice', name: 'Alice' },
      { deviceId: 'dev-bob', name: 'Bob' },
    ];
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, winningScore: 6000,
      players: [
        { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: ALICE_WON },
        { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: BOB_LOST, disconnected: true },
      ],
    });
    rooms[roomId].disconnectTimers['dev-bob'] = setTimeout(() => {}, RECONNECT_TIMER_MS);
    // The finish freezes the verdict and writes Bob's verdict-only row.
    emitRoomState(makeFakeIo().io, roomId);
  };

  /** Bob is back, and his client submits the game it has been holding. */
  const bobSubmits = async (stats: Record<string, unknown>) => {
    const bobSeat = nonNull(rooms[roomId].state.players.find(p => p.deviceId === 'dev-bob'));
    bobSeat.disconnected = false;
    const fake = makeFakeSocket('bob-sock');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
    await fake.handlers['endGameStats']({ deviceId: 'dev-bob', stats });
  };

  const BOB_PAYLOAD = {
    gamesPlayed: 1, wins: 1, totalTurns: BOB_TURNS, busts: BOB_BUSTS,
    totalTuttos: BOB_TUTTOS, mostCardsInTurn: BOB_MOST_CARDS,
    totalPlayersSum: SEATS_AT_KICKOFF, mostPlayersInGame: SEATS_AT_KICKOFF,
  };

  it('adds the per-turn counters and records the verdict row could not know', async () => {
    stageBobDroppedAtFinish();
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);

    await bobSubmits(BOB_PAYLOAD);

    expect(updateDeviceStats).toHaveBeenCalledTimes(2);
    const merged = vi.mocked(updateDeviceStats).mock.calls[1][1];
    expect(merged.busts, 'the counters the client was holding').toBe(BOB_BUSTS);
    expect(merged.totalTuttos).toBe(BOB_TUTTOS);
    expect(merged.mostCardsInTurn).toBe(BOB_MOST_CARDS);
    expect(merged.totalTurns).toBe(BOB_TURNS);
    expect(merged.fastestLossTurns, 'the record this game earned').toBe(BOB_TURNS);
    expect(vi.mocked(updateDeviceStats).mock.calls[1][2], 'the same bucket the verdict row went to').toBe('normalized');
  });

  it('does not count the game, the seats, or the verdict a second time', async () => {
    stageBobDroppedAtFinish();
    const verdictRow = vi.mocked(updateDeviceStats).mock.calls[0][1];
    expect(verdictRow.gamesPlayed, 'the verdict row counted the game').toBe(1);

    await bobSubmits(BOB_PAYLOAD);

    const merged = vi.mocked(updateDeviceStats).mock.calls[1][1];
    expect(merged.gamesPlayed, 'the game is already counted').toBe(0);
    expect(merged.totalPlayersSum, 'so are the seats at the table (an additive column)').toBe(0);
    expect(merged.mostPlayersInGame, 'a MAX column is safe to repeat').toBe(SEATS_AT_KICKOFF);
    // `wins` is what makes updateDeviceStats re-run the streak CASE, and a
    // second run would reset the streak the verdict row already set.
    expect('wins' in merged, 'the verdict is not restated, so the streak is not touched again').toBe(false);
  });

  it('cannot flip a lost game into a win, whatever the client claims', async () => {
    stageBobDroppedAtFinish();

    await bobSubmits({ ...BOB_PAYLOAD, wins: 1, fastestWinTurns: BOB_TURNS });

    const merged = vi.mocked(updateDeviceStats).mock.calls[1][1];
    expect(merged.wins, 'Bob lost — the frozen verdict says so').toBeUndefined();
    expect(merged.fastestWinTurns, 'and a loss sets no fastest-win record').toBeNull();
  });

  it('is a no-op for a third submission of the same game', async () => {
    stageBobDroppedAtFinish();

    await bobSubmits(BOB_PAYLOAD);
    await bobSubmits(BOB_PAYLOAD);

    expect(updateDeviceStats, 'the verdict row plus exactly one merge').toHaveBeenCalledTimes(2);
  });

  it('leaves a seat that never comes back with its verdict-only row alone', async () => {
    stageBobDroppedAtFinish();

    emitRoomState(makeFakeIo().io, roomId);

    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    expect(rooms[roomId].statsRecordedForGame.devices.get('dev-bob')).toBe('verdict-only');
  });

  it('reopens only the merge when the merge write fails, never the verdict row', async () => {
    stageBobDroppedAtFinish();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(updateDeviceStats).mockRejectedValueOnce(new Error('write failed'));

    await bobSubmits(BOB_PAYLOAD);

    expect(errorSpy).toHaveBeenCalledWith('[endGameStats] error:', expect.anything());
    // Back to verdict-only, NOT to "nothing recorded" — a retry must merge
    // again rather than count the game a second time.
    expect(rooms[roomId].statsRecordedForGame.devices.get('dev-bob')).toBe('verdict-only');

    await bobSubmits(BOB_PAYLOAD);
    const retried = vi.mocked(updateDeviceStats).mock.calls[2][1];
    expect(retried.gamesPlayed, 'the retry is still a merge').toBe(0);
    expect(retried.busts).toBe(BOB_BUSTS);
    errorSpy.mockRestore();
  });
});

describe('a submission carrying no usable game data still records the verdict', () => {
  // Item W7-2: an empty (or entirely invalid) payload sanitizes to {}, and the
  // server's verdict override then filled it with `wins` and the record
  // fields — but nothing ever put a `gamesPlayed` in it. The row that landed
  // said the device had WON a game it had never played: wins 1 against
  // gamesPlayed 0, plus a win streak. The honest minimum for a finished game
  // the server holds a verdict for is the same row it writes for a departed
  // seat — the game, and its outcome.
  const roomId = 'EMPTY-PAYLOAD-ROOM';
  const ALICE_WON = 10000;
  const BOB_LOST = 4000;
  const WINNING_SCORE = 6000;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  /** Alice won, Bob lost, both still seated — so neither has a server row yet. */
  const stageFinishedGame = () => {
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, winningScore: WINNING_SCORE,
      players: [
        { ...makePlayer('Alice', 'alice-sock', 'dev-alice'), score: ALICE_WON },
        { ...makePlayer('Bob', 'bob-sock', 'dev-bob'), score: BOB_LOST },
      ],
    });
    emitRoomState(makeFakeIo().io, roomId);
  };

  const submit = async (name: string, socketId: string, deviceId: string, stats: unknown) => {
    const fake = makeFakeSocket(socketId);
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: name } });
    await fake.handlers['endGameStats']({ deviceId, stats });
    return vi.mocked(updateDeviceStats).mock.calls[0][1];
  };

  it('counts the game an empty payload came with, rather than a win without one', async () => {
    stageFinishedGame();

    const written = await submit('Alice', 'alice-sock', 'dev-alice', {});

    expect(written.gamesPlayed, 'the game was played').toBe(1);
    expect(written.wins, 'and the frozen verdict says she won it').toBe(1);
    expect(Number(written.wins), 'a win is never recorded without the game')
      .toBeLessThanOrEqual(Number(written.gamesPlayed));
  });

  it('treats a payload of nothing but garbage keys the same way', async () => {
    stageFinishedGame();

    const written = await submit('Alice', 'alice-sock', 'dev-alice',
      { nonsense: 'x', junk: {}, worse: [1], gamesPlayed: 'not a number' });

    expect(written.gamesPlayed).toBe(1);
    expect(written.wins).toBe(1);
  });

  it('records a played, lost game for a loser who submits nothing', async () => {
    stageFinishedGame();

    const written = await submit('Bob', 'bob-sock', 'dev-bob', {});

    expect(written.gamesPlayed).toBe(1);
    expect(written.wins, 'Bob lost').toBe(0);
  });

  it('leaves a room that froze no verdict with nothing to write', async () => {
    // No broadcast, so no finishedGame — there is no outcome to record and an
    // empty payload adds nothing. updateDeviceStats no-ops on {} anyway; what
    // matters is that no gamesPlayed is invented out of a bare `finished`.
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    const written = await submit('Alice', 'alice-sock', 'dev-alice', {});

    expect(written).toEqual({});
  });
});
