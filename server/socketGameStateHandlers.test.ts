/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerGameStateHandlers, MAX_TIMER_RESTARTS_PER_TURN, DRAW_CARD_LIMIT } from './socketGameStateHandlers';
import { makeFakeSocket, makeFakeIo, makeServerPlayer, type Handler } from './socketTestHarness';
import { rooms, createRoom, deleteRoom } from './rooms';
import type { RoomState } from './roomTypes';

// This file's players default to position: 1 (rather than makeServerPlayer's
// own default of 0) — kept as an explicit override below so converting to
// the shared factory doesn't change what these fixtures build.
const makePlayer = (name: string, socketId: string) => makeServerPlayer(name, { socketId, position: 1 });

// Stands in for a device whose row the room has already written for the game
// it is currently sitting on — only that the dedup entry survives matters.
const PREVIOUS_GAME_DEVICE = 'dev-already-recorded';

describe('pushState turn-timer restarts', () => {
  const roomId = 'TIMER-RESTART-ROOM';
  const TURN_START = 500_000;
  const PUSH_TIME = 1_000_000;
  let pushState: Handler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PUSH_TIME);
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('active-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['300', '200'],
      round: 1, turnDuration: 60, turnStartTime: TURN_START,
      players: [makePlayer('Alice', 'active-sock'), makePlayer('Bob', 'other-sock')],
    });
    // The current turn is already "seen" — only a real change may restart it.
    rooms[roomId].turnTimerState = {
      lastCard: '300', lastPlayerIndex: 0, lastDeckSize: 2, restartsThisTurn: 0,
    };

    const fake = makeFakeSocket('active-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('does not restart for a card flip that changes neither player nor deck', () => {
    // The counter-abuse: a patched active player flipping currentCard back
    // and forth used to reset the deadline indefinitely, defeating the
    // server-authoritative expiry. (Since the deck became server-owned the
    // flip is not even applied — but the deadline is what this pins.)
    pushState({ roomId, newState: { currentCard: '400' } });

    expect(rooms[roomId].state.turnStartTime).toBe(TURN_START);
  });

  it('a player change always restarts and resets the budget', () => {
    rooms[roomId].turnTimerState!.restartsThisTurn = MAX_TIMER_RESTARTS_PER_TURN;

    // A real turn hand-over, which is also what makes the server deal the
    // next seat its card (see the deck-authority suite below).
    pushState({ roomId, newState: { currentPlayerIndex: 1, previousCard: '300', previousPlayerName: 'Alice' } });

    expect(rooms[roomId].state.turnStartTime).toBe(PUSH_TIME);
    expect(rooms[roomId].turnTimerState?.restartsThisTurn).toBe(0);
  });

  // The mid-chain draw used to arrive here, as a pushed deck one card shorter,
  // and this suite pinned the restart and the per-turn budget it earned. It
  // takes the drawCard event now — a push can no longer write the deck at all
  // — so both live in the 'drawCard' suite at the bottom of this file.
});

describe('pushState authorization', () => {
  // The spawned-server twin of this check (sockets.authorization.test.ts)
  // could not fail: its hostile push carried `players: []`, which the roster
  // gate discards before the authorization line is ever consulted. These
  // cases push a lone `currentPlayerIndex` — the field nothing but the
  // authorization line stands between a bystander and.
  const roomId = 'AUTHZ-ROOM';
  const ACTIVE_INDEX = 1;

  const seat = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    const { io, emit } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId, username } });
    return { pushState: fake.handlers['pushState'], emit };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: ACTIVE_INDEX, currentCard: '300',
      cards: ['200'], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      winningScore: 6000,
      players: [
        makePlayer('Alice', 'host-sock'),
        makePlayer('Bob', 'active-sock'),
        makePlayer('Carol', 'bystander-sock'),
      ],
    });
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('ignores a seated bystander who is neither host nor the active player', () => {
    const carol = seat('bystander-sock', 'Carol');

    carol.pushState({ roomId, newState: { currentPlayerIndex: 2 } });

    expect(rooms[roomId].state.currentPlayerIndex, 'the turn stays where it was').toBe(ACTIVE_INDEX);
    expect(carol.emit, 'a refused push is not broadcast').not.toHaveBeenCalled();
  });

  it('ignores a socket that is not seated in the room at all', () => {
    const stranger = seat('stranger-sock', 'Mallory');

    stranger.pushState({ roomId, newState: { currentPlayerIndex: 2 } });

    expect(rooms[roomId].state.currentPlayerIndex).toBe(ACTIVE_INDEX);
    expect(stranger.emit).not.toHaveBeenCalled();
  });

  it('accepts the same push from the active player, who is not the host', () => {
    // The control: without it the refusals above would also pass for a
    // handler that ignores everyone.
    const bob = seat('active-sock', 'Bob');

    bob.pushState({ roomId, newState: { currentPlayerIndex: 2 } });

    expect(rooms[roomId].state.currentPlayerIndex).toBe(2);
    expect(bob.emit).toHaveBeenCalled();
  });

  it('accepts it from the host, who is not the active player', () => {
    const alice = seat('host-sock', 'Alice');

    alice.pushState({ roomId, newState: { currentPlayerIndex: 2 } });

    expect(rooms[roomId].state.currentPlayerIndex).toBe(2);
  });
});

describe('pushState acknowledgement and stateVersion', () => {
  // pushState used to be fire-and-forget in both directions: a refused push
  // told the sender nothing, and a broadcast carried no ordering information,
  // so a late one could overwrite newer local state. The ack names the
  // refusal; the version lets the client floor what it applies.
  const roomId = 'ACK-ROOM';
  const ACTIVE_INDEX = 1;

  const seat = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    const { io, emit } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId, username } });
    return { handlers: fake.handlers, socket: fake.socket, emit };
  };

  const gameStates = (emit: ReturnType<typeof makeFakeIo>['emit']) =>
    emit.mock.calls.filter(([event]) => event === 'gameState').map(([, payload]) => payload);

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: ACTIVE_INDEX, currentCard: '300',
      cards: ['200'], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      winningScore: 6000,
      players: [
        makePlayer('Alice', 'host-sock'),
        makePlayer('Bob', 'active-sock'),
        makePlayer('Carol', 'bystander-sock'),
      ],
    });
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('acks an accepted push with the bumped state version', () => {
    const bob = seat('active-sock', 'Bob');
    const before = rooms[roomId].stateVersion;
    const ack = vi.fn();

    bob.handlers['pushState']({ roomId, newState: { round: 2 } }, ack);

    expect(rooms[roomId].state.round).toBe(2);
    expect(ack).toHaveBeenCalledWith({ ok: true, stateVersion: before + 1 });
    expect(rooms[roomId].stateVersion).toBe(before + 1);
  });

  it('acks a bystander\'s push as unauthorized and broadcasts nothing', () => {
    const carol = seat('bystander-sock', 'Carol');
    const ack = vi.fn();

    carol.handlers['pushState']({ roomId, newState: { round: 2 } }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'unauthorized' });
    expect(rooms[roomId].state.round, 'the refused push changed nothing').toBe(1);
    expect(carol.emit, 'a refused push is not broadcast').not.toHaveBeenCalled();
  });

  it('acks a push whose roster no longer matches as stale-roster', () => {
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.handlers['pushState']({
      roomId,
      newState: { round: 2, players: [{ name: 'Alice' }, { name: 'Bob' }] },
    }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'stale-roster' });
    expect(rooms[roomId].state.round, 'the whole snapshot is discarded').toBe(1);
  });

  it('acks a push naming no room as no-room, and a malformed one as refused', () => {
    const bob = seat('active-sock', 'Bob');
    const missingRoom = vi.fn();
    const malformed = vi.fn();

    bob.handlers['pushState']({ roomId: 'NO-SUCH-ROOM', newState: { round: 2 } }, missingRoom);
    bob.handlers['pushState'](null, malformed);

    expect(missingRoom).toHaveBeenCalledWith({ ok: false, reason: 'no-room' });
    expect(malformed).toHaveBeenCalledWith({ ok: false, reason: 'refused' });
  });

  it('still applies a push from a client that passes no callback at all', () => {
    // Wire compatibility: a client predating the ack sends two arguments, and
    // socket.io then hands the handler no callback.
    const bob = seat('active-sock', 'Bob');

    expect(() => bob.handlers['pushState']({ roomId, newState: { round: 2 } })).not.toThrow();

    expect(rooms[roomId].state.round).toBe(2);
    expect(bob.emit).toHaveBeenCalled();
  });

  it('carries a monotonically increasing stateVersion on every broadcast', () => {
    const bob = seat('active-sock', 'Bob');

    bob.handlers['pushState']({ roomId, newState: { round: 2 } });
    bob.handlers['pushState']({ roomId, newState: { round: 3 } });

    const versions = gameStates(bob.emit).map(state => (state as { stateVersion: number }).stateVersion);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toBeGreaterThan(versions[0]);
  });

  it('answers requestState on the asking socket alone, without bumping the version', () => {
    const bob = seat('active-sock', 'Bob');
    const versionBefore = rooms[roomId].stateVersion;

    bob.handlers['requestState']({ roomId });

    const direct = (bob.socket.emit as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'gameState');
    expect(direct, 'the requester gets its own copy').toHaveLength(1);
    expect((direct[0][1] as { stateVersion: number }).stateVersion).toBe(versionBefore);
    expect(bob.emit, 'nobody else is told anything').not.toHaveBeenCalled();
    expect(rooms[roomId].stateVersion, 'a read is not a mutation').toBe(versionBefore);
  });

  it('refuses requestState from a socket whose session is not in that room', () => {
    const fake = makeFakeSocket('stranger-sock');
    const { io } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId: null, username: null } });

    fake.handlers['requestState']({ roomId });

    expect(fake.socket.emit).not.toHaveBeenCalled();
  });

  it('refuses requestState from a socket that still names the room but holds no seat', () => {
    // A kicked socket, or one superseded by a same-device takeover: neither
    // path clears the ConnectionSession, so `session.roomId` still names the
    // room it was thrown out of. Gating on that alone let it keep pulling the
    // full live gameState — roster, scores, every other seat's socketId — at
    // the limiter's five calls a second, for as long as it stayed connected.
    const ghost = seat('kicked-sock', 'Mallory');

    ghost.handlers['requestState']({ roomId });

    expect(ghost.socket.emit, 'no seat, no state').not.toHaveBeenCalled();
  });
});

describe('pushState may not leave a running game with nobody to act', () => {
  const roomId = 'STALL-ROOM';
  let pushState: Handler;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: 0, currentCard: '300',
      cards: ['200'], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      winningScore: 6000,
      players: [makePlayer('Alice', 'active-sock'), makePlayer('Bob', 'host-sock')],
    });
    const fake = makeFakeSocket('active-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('refuses a bare currentPlayerIndex: null from the active player', () => {
    // `null` is legal — it is what the WINNING push carries — but only
    // alongside the finish. On its own it strands the room: the timer-restart
    // branch needs a non-null index and the teardown branch needs
    // finished/lobby, so the server arms no timer AND clears none, and the
    // pending expiry returns early forever after. Nothing short of a host push
    // recovers it, and turnTimers' own header promises the opposite ("a
    // backgrounded/throttled client tab can never stall the game").
    pushState({ roomId, newState: { currentPlayerIndex: null } });

    const state = rooms[roomId].state;
    expect(state.currentPlayerIndex, 'a running game keeps an active player').toBe(0);
    expect(state.status).toBe('playing');
    expect(state.finished).toBe(false);
  });

  it('still accepts currentPlayerIndex: null when it rides the winning push', () => {
    // The control for the guard above: the legitimate use of `null` must keep
    // working, or the refusal is indistinguishable from breaking game-over.
    rooms[roomId].state.players[0].score = 6000;

    pushState({ roomId, newState: { currentPlayerIndex: null, finished: true } });

    const state = rooms[roomId].state;
    expect(state.finished, 'a real game-over is still accepted').toBe(true);
    expect(state.currentPlayerIndex).toBeNull();
    expect(rooms[roomId].finishedGame?.winners).toEqual(['Alice']);
  });

  it('refuses a host push that starts a game without saying whose turn it is', () => {
    // The same incoherence from the other side: status alone, no index. The
    // guard must restore BOTH fields, or a room that had no index to go back
    // to is stranded exactly as above.
    rooms[roomId].state.status = 'lobby';
    rooms[roomId].state.currentPlayerIndex = null;
    // The previous game's bookkeeping, which a real start would clear and
    // recapture — and which this push must leave exactly as it found it.
    const previousGameDevices = new Map([[PREVIOUS_GAME_DEVICE, 'full' as const]]);
    rooms[roomId].statsRecordedForGame = { devices: previousGameDevices, global: true };
    const hostFake = makeFakeSocket('host-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: hostFake.socket, session: { roomId, username: 'Bob' } });

    hostFake.handlers['pushState']({ roomId, newState: { status: 'playing' } });

    expect(rooms[roomId].state.status, 'a game cannot start with nobody to act').toBe('lobby');
    // …and no game started means none of the start-of-game bookkeeping may
    // run either. It used to, gated on `applied` alone: the dedup was reset
    // (letting the still-finished game's statistics be submitted a second
    // time) and the start roster was recaptured for a game the room put
    // straight back into the lobby.
    expect(rooms[roomId].startRoster, 'no game started, no roster to capture').toBeNull();
    expect(rooms[roomId].statsRecordedForGame.devices, 'the previous game stays deduped')
      .toBe(previousGameDevices);
    expect(rooms[roomId].statsRecordedForGame.global).toBe(true);
  });

  // The third way into the same stranded room, and the one the repair could
  // not repair: a FINISHED game is status 'playing' / finished true /
  // currentPlayerIndex null, so a push that only clears `finished` leaves a
  // running game with nobody to act — and both existing fallbacks are no-ops
  // there (the index was already null, the status was already 'playing').
  const stageFinishedGame = () => {
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, currentCard: null,
      turnStartTime: null,
    });
  };

  const hostPush = (): Handler => {
    const hostFake = makeFakeSocket('host-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: hostFake.socket, session: { roomId, username: 'Bob' } });
    return hostFake.handlers['pushState'];
  };

  it('refuses a HOST push that finishes a game on tied leaders, and freezes no verdict', () => {
    // The engine never ends a game on a tie — a tie plays another round — but
    // applyFinished used to wave the HOST through unconditionally. The verdict
    // rememberFinishedGame then froze named BOTH leaders as winners, and each
    // took a win and a fastestWinTurns that no later correction can undo.
    const { winningScore } = rooms[roomId].state;

    hostPush()({
      roomId,
      newState: {
        players: [{ name: 'Alice', score: winningScore }, { name: 'Bob', score: winningScore }],
        finished: true,
        currentPlayerIndex: null,
      },
    });

    const state = rooms[roomId].state;
    expect(state.finished, 'a tie is not a win, not even for the host').toBe(false);
    expect(state.currentPlayerIndex, 'the coherence repair keeps someone to act').toBe(0);
    expect(rooms[roomId].finishedGame, 'no verdict may be frozen for a tie').toBeNull();
  });

  it('still accepts the HOST push that ends a game a sole leader won, and freezes one winner', () => {
    // The control for the guard above: the host's own winning push is the
    // ordinary way a game ends when the host is the active player.
    const { winningScore } = rooms[roomId].state;

    hostPush()({
      roomId,
      newState: {
        players: [{ name: 'Alice', score: winningScore }, { name: 'Bob', score: 100 }],
        finished: true,
        currentPlayerIndex: null,
      },
    });

    expect(rooms[roomId].state.finished).toBe(true);
    expect(rooms[roomId].finishedGame?.winners).toEqual(['Alice']);
  });

  it('still accepts the host ending the game early, which tears it down to the lobby', () => {
    // gameSlice.endGame — the only explicit early-end the UI offers, host-only
    // online — pushes finished: false with status 'lobby'. It never asserts a
    // winner, so the game-over rule above does not touch it.
    hostPush()({
      roomId,
      newState: {
        status: 'lobby', finished: false, currentPlayerIndex: null, round: 1,
        chartValues: [], chartNames: [], chartLabels: [],
      },
    });

    const state = rooms[roomId].state;
    expect(state.status, 'End Game returns the room to the lobby').toBe('lobby');
    expect(state.finished).toBe(false);
    expect(rooms[roomId].finishedGame, 'an abandoned game has no verdict').toBeNull();
  });

  it('refuses a host push that un-finishes a game without saying whose turn it is', () => {
    stageFinishedGame();

    hostPush()({ roomId, newState: { finished: false } });

    const state = rooms[roomId].state;
    expect(state.finished, 'the un-finish is given up instead of the room being stranded').toBe(true);
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.status).toBe('playing');
  });

  it('still accepts the real Play Again, which names the first player', () => {
    // The control for the guard above: Play Again is exactly a finished ->
    // playing push carrying finished: false, and it must keep working.
    stageFinishedGame();

    hostPush()({
      roomId,
      newState: {
        status: 'playing', finished: false, currentPlayerIndex: 0, round: 1,
        players: [{ name: 'Alice', score: 0 }, { name: 'Bob', score: 0 }],
      },
    });

    const state = rooms[roomId].state;
    expect(state.finished, 'a rematch that names an actor is a legitimate un-finish').toBe(false);
    expect(state.currentPlayerIndex).toBe(0);
  });
});

describe('pushState against an already-finished game', () => {
  const roomId = 'FINISHED-CLOCK-ROOM';
  const GAME_START = 500_000;
  const GAME_END = 920_000; // 7 minutes of play
  const LATER_PUSH = 1_000_000;
  const PLAYED_SECONDS = (GAME_END - GAME_START) / 1000;
  let pushState: Handler;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('active-sock');
    // A finished game keeps status 'playing' with finished: true all the way
    // through the end screen (see the startingGame comment in pushState), and
    // the finishing push already nulled gameActualStartTime while banking the
    // elapsed time into gameTimeInSeconds.
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null, currentCard: null,
      round: 5, turnDuration: 60, turnStartTime: null,
      gameTimeInSeconds: PLAYED_SECONDS,
      players: [makePlayer('Alice', 'active-sock'), makePlayer('Bob', 'other-sock')],
    });
    rooms[roomId].gameActualStartTime = null;

    const fake = makeFakeSocket('active-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
    vi.setSystemTime(LATER_PUSH);
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.useRealTimers();
  });

  it('does not re-arm the clock, so the final game time survives a later push', () => {
    // status is still 'playing', so the "game is running, start the clock"
    // branch re-armed gameActualStartTime to now — and the finished branch a
    // few lines below then recomputed gameTimeInSeconds as now-minus-now = 0
    // and broadcast it, repainting every end screen to 00:00.
    pushState({ roomId, newState: { round: 5 } });

    expect(rooms[roomId].gameActualStartTime).toBeNull();
    expect(rooms[roomId].state.gameTimeInSeconds).toBe(PLAYED_SECONDS);
  });

  it('DOES start a fresh clock when Play Again actually restarts the game', () => {
    // The other side of the !finished guard. A rematch is exactly the push
    // that clears finished, and it must get a new anchor — guarding on status
    // alone was wrong, but guarding too eagerly would leave the next game
    // timing from null and reporting 0.
    pushState({
      roomId,
      newState: {
        status: 'playing', finished: false, currentPlayerIndex: 0, round: 1,
        players: [{ name: 'Alice' }, { name: 'Bob' }],
      },
    });

    expect(rooms[roomId].state.finished).toBe(false);
    expect(rooms[roomId].gameActualStartTime).toBe(LATER_PUSH);
  });

  it('does not zero the clock even when the push is discarded for a stale roster', () => {
    // applyPushedState bails on a roster mismatch, but the clock bookkeeping
    // ran regardless of whether anything was applied — so a Play Again click
    // carrying a roster a departing player had just invalidated still wiped
    // the finished game's duration.
    pushState({ roomId, newState: { players: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }] } });

    expect(rooms[roomId].state.gameTimeInSeconds).toBe(PLAYED_SECONDS);
  });
});

describe('pushState captures the game-start roster (startRoster)', () => {
  // A seat that leaves, is kicked, or times out before the game's finish is
  // broadcast is invisible to endGameStats (see socketStatsHandlers.ts) —
  // that handler only ever hears from a currently seated socket. The server
  // records that seat's row itself instead (rooms.ts' recordDepartedSeatsStats),
  // and it can only tell who was AT the table when the game began by
  // capturing the roster right here, the one place a game start is detected
  // (see the startingGame comment above).
  const roomId = 'ROSTER-CAPTURE-ROOM';
  let pushState: Handler;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      status: 'lobby', finished: false, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock'), makePlayer('Bob', 'bob-sock')],
    });
    const fake = makeFakeSocket('alice-sock');
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    pushState = fake.handlers['pushState'];
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('captures every seat\'s deviceId and name on lobby -> playing', () => {
    expect(rooms[roomId].startRoster).toBeNull();

    pushState({ roomId, newState: { status: 'playing', currentPlayerIndex: 0 } });

    expect(rooms[roomId].startRoster).toEqual([
      { deviceId: 'dev-Alice', name: 'Alice' },
      { deviceId: 'dev-Bob', name: 'Bob' },
    ]);
  });

  it('does not capture anything from a push a stale roster gets discarded wholesale', () => {
    // A host push whose roster no longer matches the room's is thrown away
    // entirely (validatePushedPlayers) — `applied` is false, so this must not
    // run at all, or a discarded "start" would freeze a roster the room never
    // actually adopted.
    pushState({
      roomId,
      newState: {
        status: 'playing', currentPlayerIndex: 0,
        players: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
      },
    });

    expect(rooms[roomId].startRoster).toBeNull();
    expect(rooms[roomId].state.status, 'the discarded push must not have started the game either').toBe('lobby');
  });

  it('re-captures the roster on Play Again: a joiner is included, a leaver is not', () => {
    // Game 1 starts and finishes with Alice and Bob. Alice takes the winning
    // score, because a finish is only accepted for a game the engine could
    // have ended (pushValidation's applyFinished).
    pushState({ roomId, newState: { status: 'playing', currentPlayerIndex: 0 } });
    rooms[roomId].state.players[0].score = rooms[roomId].state.winningScore;
    pushState({ roomId, newState: { finished: true } });
    expect(rooms[roomId].startRoster).toEqual([
      { deviceId: 'dev-Alice', name: 'Alice' },
      { deviceId: 'dev-Bob', name: 'Bob' },
    ]);

    // Between games: Bob leaves, Carol joins — mirrors what a real
    // joinRoom/handlePlayerLeave pair would have done to the roster.
    rooms[roomId].state.players = [
      makePlayer('Alice', 'alice-sock'),
      makePlayer('Carol', 'carol-sock'),
    ];

    // "Play Again" — finished -> playing without a lobby stop — carries the
    // host's freshly composed roster.
    pushState({
      roomId,
      newState: {
        status: 'playing', finished: false, currentPlayerIndex: 0,
        players: [{ name: 'Alice', score: 0 }, { name: 'Carol', score: 0 }],
      },
    });

    expect(rooms[roomId].startRoster).toEqual([
      { deviceId: 'dev-Alice', name: 'Alice' },
      { deviceId: 'dev-Carol', name: 'Carol' },
    ]);
  });
});

/**
 * The live dice feed is the ACTIVE player's, and only theirs.
 *
 * The guard used to be `!isHost && !isActivePlayer`, which let the host write
 * the snapshot during someone else's turn — and turnTimers reads exactly that
 * snapshot into the timed-out player's own highestForfeitedTurnScore, which
 * their unmodified client then submits for their device, where the DB merges
 * it with MAX. Permanent, silent, and aimed at a victim who did nothing.
 *
 * Nothing legitimate emits this as a non-active host: the physical-dice relay
 * is gated on isMyTurn and the dice modal is force-closed for every non-active
 * client.
 */
describe('liveTurnState authorization', () => {
  const roomId = 'LIVE-TURN-ROOM';
  const ACTIVE_INDEX = 1;

  const snapshot = (turnScore: number) => ({
    turnScore, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [],
  });

  const seat = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    const { io, emit } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId, username } });
    return { liveTurnState: fake.handlers['liveTurnState'], emit };
  };

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: ACTIVE_INDEX, currentCard: '300',
      cards: ['200'], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      liveTurnState: snapshot(150),
      players: [
        makePlayer('Alice', 'host-sock'),
        makePlayer('Bob', 'active-sock'),
        makePlayer('Carol', 'bystander-sock'),
      ],
    });
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('refuses a host who is not the active player', () => {
    const alice = seat('host-sock', 'Alice');

    alice.liveTurnState({ roomId, liveTurnState: snapshot(9_999) });

    expect(rooms[roomId].state.liveTurnState, 'the host planted a snapshot on Bob\'s turn')
      .toEqual(snapshot(150));
    expect(alice.emit, 'a refused relay is not broadcast').not.toHaveBeenCalled();
  });

  it('refuses a host wiping the active player\'s snapshot', () => {
    // The other half of the same hole: `null` is a valid payload, so a host
    // could erase the live view the room is watching, and with it the
    // forfeited-score the timeout path is about to read.
    const alice = seat('host-sock', 'Alice');

    alice.liveTurnState({ roomId, liveTurnState: null });

    expect(rooms[roomId].state.liveTurnState).toEqual(snapshot(150));
  });

  it('refuses a seated bystander', () => {
    const carol = seat('bystander-sock', 'Carol');

    carol.liveTurnState({ roomId, liveTurnState: snapshot(9_999) });

    expect(rooms[roomId].state.liveTurnState).toEqual(snapshot(150));
  });

  it('still accepts it from the active player, who is not the host', () => {
    // The control: without it the refusals above would also pass for a handler
    // that ignores everyone.
    const bob = seat('active-sock', 'Bob');

    bob.liveTurnState({ roomId, liveTurnState: snapshot(400) });

    expect(rooms[roomId].state.liveTurnState).toEqual(snapshot(400));
    expect(bob.emit).toHaveBeenCalledWith('liveTurnState', { liveTurnState: snapshot(400) });
  });
});

/**
 * The server deals every card a running game reveals.
 *
 * `cards` is the ordered undrawn deck, so a client that can write it chooses
 * its own next card — and in the classic rule set that IS the game. Both
 * `cards` and `currentCard` left every writable field set (server/pushValidation.ts);
 * these are the paths that replaced them.
 */
describe('the server deals the cards a pushState implies', () => {
  const roomId = 'DECK-AUTHORITY-ROOM';
  const DECK = ['300', '200', 'Stop', 'x2'];
  let pushState: Handler;

  const seat = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    registerGameStateHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username } });
    return fake.handlers['pushState'];
  };

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: 0, currentCard: 'Kniffel',
      cards: [...DECK], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      players: [makePlayer('Alice', 'host-sock'), makePlayer('Bob', 'other-sock')],
    });
    // Alice's turn is in progress on the card the server dealt her, which is
    // what a kickoff (or the previous advance) would have recorded — the log
    // an undo reconstructs the deck from. Seeded here because this fixture
    // assembles the room directly instead of playing into it.
    rooms[roomId].dealtThisTurn = ['Kniffel'];
    pushState = seat('host-sock', 'Alice');
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('deals the next seat the top card, not the one the push named', () => {
    // The exploit in one push: read cards[0] out of the store, then push a
    // different card as the one you drew.
    pushState({
      roomId,
      newState: {
        currentPlayerIndex: 1, previousCard: 'Kniffel', previousPlayerName: 'Alice',
        currentCard: 'Kleeblatt', cards: ['Kleeblatt', 'Kleeblatt'],
      },
    });

    expect(rooms[roomId].state.currentCard).toBe('300');
    expect(rooms[roomId].state.cards).toEqual(['200', 'Stop', 'x2']);
  });

  it('leaves the deck alone for a push that did not move the turn', () => {
    pushState({ roomId, newState: { currentPlayerIndex: 0, cards: [], currentCard: 'Stop' } });

    expect(rooms[roomId].state.currentCard).toBe('Kniffel');
    expect(rooms[roomId].state.cards).toEqual(DECK);
  });

  it('builds its own deck for a game start, so the host cannot stack it', () => {
    const room = rooms[roomId];
    Object.assign(room.state, {
      status: 'lobby', currentPlayerIndex: null, currentCard: null, cards: [],
      initialCards: { '300': 2, '400': 2 },
    });

    pushState({
      roomId,
      newState: {
        status: 'playing', currentPlayerIndex: 0, finished: false,
        cards: ['Kleeblatt', 'Kleeblatt', 'Kleeblatt'], currentCard: 'Kleeblatt',
      },
    });

    expect(room.state.cards).not.toContain('Kleeblatt');
    expect([...room.state.cards, room.state.currentCard].sort()).toEqual(['300', '300', '400', '400']);
  });

  it('clears the deck when the host ends the game into the lobby', () => {
    pushState({ roomId, newState: { status: 'lobby', currentPlayerIndex: null, finished: false } });

    expect(rooms[roomId].state.cards).toEqual([]);
    expect(rooms[roomId].state.currentCard).toBeNull();
  });

  it('gives an undone turn its card back rather than dealing a fresh one', () => {
    // Driven as a real round trip rather than assembled: the advance is what
    // writes the server's record of what Alice's turn was dealt, and the undo
    // has to reconstruct the deck from THAT. Hand-setting the state instead
    // would skip the half of this that matters.
    const room = rooms[roomId];
    pushState({
      roomId,
      newState: { currentPlayerIndex: 1, previousCard: 'Kniffel', previousPlayerName: 'Alice' },
    });
    expect(room.state.currentCard, 'Bob was dealt the top card').toBe('300');

    pushState({
      roomId,
      newState: {
        currentPlayerIndex: 0, previousCard: null, previousPlayerName: null, previousTurnSummary: null,
      },
    });

    expect(room.state.currentCard, 'the undone turn is replayed on its own card').toBe('Kniffel');
    expect(room.state.cards, 'and the discarded turn gives its card back').toEqual(DECK);
  });

  it('an undo cannot hand the player a card it named in previousTurnSummary', () => {
    // The restore used to be built from previousTurnSummary/liveTurnState,
    // both pushable — so the cards it gave back were the caller's to choose,
    // and currentCard was whichever they put first. Repeating it prepended an
    // arbitrary run of chosen cards to the deck.
    const room = rooms[roomId];
    pushState({
      roomId,
      newState: { currentPlayerIndex: 1, previousCard: 'Kniffel', previousPlayerName: 'Alice' },
    });

    pushState({
      roomId,
      newState: {
        currentPlayerIndex: 0, previousCard: null, previousPlayerName: null,
        previousTurnSummary: {
          cards: [{ card: '600', completed: true }, { card: '600', completed: true }],
          tuttoCount: 0, plusMinusScores: [], ended: 'banked',
        },
      },
    });

    expect(room.state.currentCard, 'not the 600 the push asked for').toBe('Kniffel');
    expect(room.state.cards).not.toContain('600');
  });
});

/**
 * The mid-turn chain draw: a classic tutto lets the active player reveal
 * another card and keep the whole running total at risk.
 *
 * It used to be entirely client-side — gameSlice.drawCardMidTurn shifted the
 * client's own copy of the deck and pushed the result — which is precisely the
 * decision the deck must not be readable for. The card is chosen here now,
 * after the player has committed to drawing.
 */
describe('drawCard', () => {
  const roomId = 'DRAW-CARD-ROOM';
  const DECK = ['300', '200'];

  const seat = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    const { io, emit } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId, username } });
    return { drawCard: fake.handlers['drawCard'], emit };
  };

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: false, currentPlayerIndex: 1, currentCard: 'Kniffel',
      cards: [...DECK], round: 1, turnDuration: 60, turnStartTime: Date.now(),
      players: [makePlayer('Alice', 'host-sock'), makePlayer('Bob', 'active-sock')],
    });
  });

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('answers the active player with the top card and takes it off the deck', () => {
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true, card: '300' });
    expect(rooms[roomId].state.currentCard).toBe('300');
    expect(rooms[roomId].state.cards).toEqual(['200']);
  });

  it('broadcasts the drawn card, so spectators see the same chain', () => {
    const bob = seat('active-sock', 'Bob');

    bob.drawCard({ roomId }, vi.fn());

    expect(bob.emit).toHaveBeenCalledWith('gameState', expect.objectContaining({ currentCard: '300' }));
  });

  it('refuses the HOST, who is not the one playing', () => {
    // pushState's own gate is `isHost || isActivePlayer`; this one is not.
    // Drawing on someone else's turn burns their card and restarts their clock.
    const alice = seat('host-sock', 'Alice');
    const ack = vi.fn();

    alice.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'unauthorized' });
    expect(rooms[roomId].state.cards).toEqual(DECK);
    expect(rooms[roomId].state.currentCard).toBe('Kniffel');
  });

  it('refuses a socket with no seat in the room', () => {
    const stranger = seat('nobody-sock', 'Mallory');
    const ack = vi.fn();

    stranger.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'unauthorized' });
    expect(rooms[roomId].state.cards).toEqual(DECK);
  });

  it('refuses a draw once the game is over', () => {
    rooms[roomId].state.finished = true;
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'not-playing' });
    expect(rooms[roomId].state.cards).toEqual(DECK);
  });

  it('names a room that is gone rather than answering nothing', () => {
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.drawCard({ roomId: 'NO-SUCH-ROOM' }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'no-room' });
  });

  it('reshuffles rather than answering null when the deck runs out', () => {
    rooms[roomId].state.cards = [];
    rooms[roomId].state.initialCards = { '300': 2 } as RoomState['initialCards'];
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true, card: '300' });
    expect(rooms[roomId].state.cards).toEqual(['300']);
  });

  it('cuts a client off past the per-second budget', () => {
    // A chain draws one card per tutto; anything faster is a client walking
    // the deck. Without a limiter this event re-serializes and broadcasts the
    // whole room on every call.
    const bob = seat('active-sock', 'Bob');
    rooms[roomId].state.cards = Array(DRAW_CARD_LIMIT.max + 1).fill('300');

    for (let i = 0; i < DRAW_CARD_LIMIT.max; i++) bob.drawCard({ roomId }, vi.fn());
    const ack = vi.fn();
    bob.drawCard({ roomId }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'rate-limited' });
  });

  it('stops restarting the clock past the per-turn budget', () => {
    // The bound that used to sit on pushState's deck-triggered restarts, now
    // that the draw is the only thing that can shrink the deck mid-turn: a
    // client drawing in a loop to hold its turn open runs out and expires.
    const room = rooms[roomId];
    room.state.cards = Array(3).fill('300');
    room.state.turnStartTime = 1;
    room.turnTimerState = {
      lastCard: 'Kniffel', lastPlayerIndex: 1, lastDeckSize: 3,
      restartsThisTurn: MAX_TIMER_RESTARTS_PER_TURN,
    };
    const bob = seat('active-sock', 'Bob');
    const ack = vi.fn();

    bob.drawCard({ roomId }, ack);

    expect(ack, 'the card is still dealt — only the deadline is not refreshed')
      .toHaveBeenCalledWith({ ok: true, card: '300' });
    expect(room.state.turnStartTime).toBe(1);
  });

  it('restarts the turn clock for the fresh card', () => {
    // The new card is a new deadline: without this a chain drawn late in a
    // turn gets whatever seconds the previous card had left. pushState grants
    // the same restart off the deck shrinking; this path never pushes.
    const room = rooms[roomId];
    room.state.turnStartTime = 1;
    const bob = seat('active-sock', 'Bob');

    bob.drawCard({ roomId }, vi.fn());

    expect(room.state.turnStartTime).toBeGreaterThan(1);
  });
});
