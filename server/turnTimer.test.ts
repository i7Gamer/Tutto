/**
 * @vitest-environment node
 *
 * Covers the server-authoritative turn timer (turnTimers.ts: startServerTurnTimer /
 * advanceTurnOnTimeout / clearServerTurnTimer). Before this feature, turn expiry was
 * driven exclusively by the host's client-side setInterval, which stalled the game if
 * the host disconnected, closed their tab, or the tab was backgrounded/throttled.
 *
 * In-process rather than a spawned server, and that is what makes the expiry
 * deterministic: room.turnExpireTimer is a handle in THIS process, so a test can
 * run it on demand instead of sleeping until its deadline. Every wait in here
 * used to be a real one — scaled down by TEST_TIMER_SCALE and then bet against.
 * "No advance within 300ms, an advance within 1000ms" asserts how fast the
 * machine is at least as much as it asserts what the server does, and it spent
 * ~6s per run doing it. Firing the handle replaces those windows with exact
 * assertions about the timer itself, which is what the tests were reaching for.
 *
 * It also puts this code in reach of coverage, which cannot see into a subprocess.
 *
 * The database module is mocked, as in every other in-process suite: a join
 * fetches both rulesets' streaks, and nothing here asserts on persistence.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import type { Socket as ClientSocket } from 'socket.io-client';
import { startInProcessServer, emitJoin, waitFor, type InProcessServer } from './socketTestHarness';
import { rooms } from './rooms';
// Rooms are stored under the canonical (trimmed, upper-cased) id since
// joinRoom started normalising; this file's lower-case ids must follow it.
import { normalizeRoomId } from '../src/utils/configValidation';
import type { GameStore } from '../src/store/storeTypes';
import { nonNull } from '../src/testing/factories';

// The shape of a 'gameState' broadcast — see socket.test.ts's identical copy
// of this type for why it is not shared via socketTestHarness.ts.
type GameStatePayload = Partial<GameStore> & { stateVersion?: number };

describe('Server-side turn timer', () => {
  let server: InProcessServer;

  /**
   * Long enough that an armed expiry cannot reach its own deadline while a test
   * is running.
   *
   * These tests RUN the timer rather than waiting for it, so a long duration is
   * free — and a short one buys nothing but a race the manual fire can lose. At
   * the 1s this file used to use, TEST_TIMER_SCALE puts the deadline 200ms out,
   * and a worker that stalls past it gets the expiry for free: the turn
   * advances and advanceTurnOnTimeout ARMS A FRESH TIMER, so fireTurnExpiry
   * finds a perfectly valid handle to run — the next turn's. Tests that then
   * assert on the first turn fail complaining about card values, saying nothing
   * about a timer; worse, the two ending in expectNoTimerArmed pass outright,
   * having cancelled a different turn's timer than the one they set up. At 30s
   * the deadline is 6s away, two orders of magnitude past the work in between.
   */
  const TURN_DURATION_S = 30;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const joinRoom = async (roomId: string, name = 'Host') => {
    const sock = await server.connect();
    // Registered before the join rather than inside its ack: joinRoom acks and
    // then broadcasts, and a listener attached after the ack has already been
    // awaited can miss the broadcast it is waiting for.
    const firstState = new Promise<GameStatePayload>(resolve => sock.once('gameState', resolve));
    const res = await emitJoin(sock, roomId, name, `dev-${roomId}-${name}`);
    if (!res.success) { sock.disconnect(); throw new Error(res.error); }
    return { sock, socketId: res.socketId, state: await firstState };
  };

  // Resolves with the first gameState matching predicate, or rejects on timeout.
  const waitForState = (
    sock: ClientSocket,
    predicate: (state: GameStatePayload) => boolean,
    timeoutMs = 6000,
  ) =>
    new Promise<GameStatePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.off('gameState', handler);
        reject(new Error('Timed out waiting for expected gameState'));
      }, timeoutMs);
      const handler = (state: GameStatePayload) => {
        if (predicate(state)) {
          clearTimeout(timer);
          sock.off('gameState', handler);
          resolve(state);
        }
      };
      sock.on('gameState', handler);
    });

  /** Resolves once the server has armed the expiry the test is about to drive. */
  const waitForArmedTimer = (roomId: string) =>
    waitFor(() => rooms[normalizeRoomId(roomId)]?.turnExpireTimer != null);

  /**
   * Runs a room's pending turn expiry now instead of waiting out its deadline.
   *
   * The callback is captured before clearing, because Node nulls a handle's
   * callback when it is cleared; clearing is what stops the real deadline
   * running the same advance a second time later. What runs is the exact
   * closure setTimeout was given — only the scheduling is skipped, and the
   * scheduling is not what any of these tests is checking.
   */
  const fireTurnExpiry = (roomId: string) => {
    const pending = rooms[normalizeRoomId(roomId)].turnExpireTimer;
    expect(pending).not.toBeNull();
    const run = (pending as unknown as { _onTimeout?: () => void })._onTimeout;
    // Guards the reach-around itself: if a Node upgrade renames this, the suite
    // must say so rather than quietly stop driving any expiry at all.
    expect(typeof run).toBe('function');
    clearTimeout(pending as ReturnType<typeof setTimeout>);
    (run as () => void)();
  };

  /**
   * Replaces the old expectNoAdvanceWithin(sock, predicate, ms), which watched
   * for an advance over a fixed window and concluded from its absence that none
   * was scheduled. That inferred the state of the timer from a silence long
   * enough to be convincing; this reads the timer.
   */
  const expectNoTimerArmed = (roomId: string) =>
    expect(rooms[normalizeRoomId(roomId)].turnExpireTimer).toBeNull();

  const twoPlayers = (roomId: string, hostSock: ClientSocket, guestSock: ClientSocket) => [
    { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
    { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
  ];

  it('server auto-advances the turn when it expires, without any client action', async () => {
    const roomId = 'timer-basic';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: '200', cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);

    const advanced = waitForState(hostSock, (s) => s.currentPlayerIndex === 1);
    fireTurnExpiry(roomId);

    const state = await advanced;
    expect(state.previousCard).toBe('200');
    expect(state.previousScore).toBe(0);
    const alice = nonNull(state.players).find(p => p.name === 'Alice');
    expect(nonNull(alice).busts).toBe(1); // no manual action was taken → counts as a bust, like a real timeout
    expect(state.historyLog).toBeDefined();
    const historyLog = nonNull(state.historyLog);
    expect(historyLog.length).toBe(1);
    expect(historyLog[0].playerName).toBe('Alice');
    expect(historyLog[0].type).toBe('bust');
    expect(historyLog[0].card).toBe('200');

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('turn still advances after the host disconnects mid-turn', async () => {
    const roomId = 'timer-host-gone';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 1, currentCard: 'Stop', cards: ['200'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);

    const advanced = waitForState(guestSock, (s) => s.round === 2);

    hostSock.disconnect(); // host is gone entirely — no client left to "own" the turn
    // The disconnect has to be PROCESSED before the expiry runs, or the test
    // proves nothing about a hostless room. It also must not free the expiry:
    // two seats remain (one disconnected), so no abort clears it.
    await waitFor(() => rooms[normalizeRoomId(roomId)].state.players.some(p => p.name === 'Alice' && p.disconnected));
    expect(rooms[normalizeRoomId(roomId)].turnExpireTimer).not.toBeNull();

    fireTurnExpiry(roomId);

    const state = await advanced;
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.status).toBe('playing');

    guestSock.disconnect();
  });

  it('turn still advances even when every client has disconnected', async () => {
    const roomId = 'timer-empty-room';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: '200', cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);

    hostSock.disconnect();
    guestSock.disconnect();
    await waitFor(() => rooms[normalizeRoomId(roomId)].state.players.every(p => p.disconnected));

    // The expiry now runs with nothing listening — which is the whole point of
    // the test, and used to be why it could only SAMPLE the result by rejoining
    // and hoping the sample landed in the right window. Driving the timer
    // directly means the advance has demonstrably already happened by the next
    // line, so the rejoin below reads a settled room rather than racing it.
    fireTurnExpiry(roomId);

    // Reconnect as Alice (same deviceId) to observe the room's current state.
    const { sock: observerSock, state } = await joinRoom(roomId, 'Alice');

    const [firstTimeout] = nonNull(state.historyLog);
    expect(firstTimeout.playerName).toBe('Alice');
    expect(firstTimeout.type).toBe('bust');
    expect(firstTimeout.card).toBe('200');
    expect(nonNull(nonNull(state.players).find(p => p.name === 'Alice')).busts).toBe(1);
    // Exactly one expiry ran, so the turn sits with Bob — an assertion the
    // sampled version could not make, because a second expiry could have
    // wrapped it back to Alice before the sample was taken.
    expect(state.currentPlayerIndex).toBe(1);

    observerSock.disconnect();
  });

  it('Feuerwerk applies a 3x turn duration multiplier', async () => {
    const roomId = 'timer-feuerwerk';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const armed = waitForState(hostSock, (s) => s.status === 'playing' && s.currentCard === 'Feuerwerk');
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });

    // The multiplier read straight off the broadcast the turn starts with.
    // turnTimeRemaining is calculateRemainingTurnTime, which is derived from
    // getEffectiveTurnDuration — the very function the multiplier lives in — so
    // this pins the multiplied duration exactly, where the old pair of timing
    // windows could only bracket it between "later than 300ms" and "sooner
    // than 1000ms".
    expect((await armed).turnTimeRemaining).toBe(TURN_DURATION_S * 3);
    await waitForArmedTimer(roomId);

    const advanced = waitForState(hostSock, (s) => s.currentPlayerIndex === 1);
    fireTurnExpiry(roomId);
    expect((await advanced).previousCard).toBe('Feuerwerk');

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('Kleeblatt applies a 2x turn duration multiplier', async () => {
    const roomId = 'timer-kleeblatt';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const armed = waitForState(hostSock, (s) => s.status === 'playing' && s.currentCard === 'Kleeblatt');
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kleeblatt', cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });

    expect((await armed).turnTimeRemaining).toBe(TURN_DURATION_S * 2);
    await waitForArmedTimer(roomId);

    const advanced = waitForState(hostSock, (s) => s.currentPlayerIndex === 1);
    fireTurnExpiry(roomId);
    expect((await advanced).previousCard).toBe('Kleeblatt');

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('turnDuration=0 disables the server timer entirely', async () => {
    const roomId = 'timer-disabled';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: '200', cards: ['300'], round: 1, turnDuration: 0,
      },
    });

    // Confirm the setup actually landed before asserting that nothing is armed.
    // A rejected push would leave a room with no turn and no timer, where "no
    // timer" holds for reasons that have nothing to do with turnDuration=0.
    await waitForState(hostSock, (s) => s.status === 'playing' && s.turnDuration === 0 && s.currentPlayerIndex === 0);

    expectNoTimerArmed(roomId);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('round-end via timeout updates chartValues/chartLabels and wraps to the next round', async () => {
    const roomId = 'timer-round-end';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 1, currentCard: '300', cards: ['200'], round: 1, turnDuration: TURN_DURATION_S,
        chartValues: [[0], [0]], chartNames: ['Alice', 'Bob'], chartLabels: [],
      },
    });
    await waitForArmedTimer(roomId);

    const advanced = waitForState(hostSock, (s) => s.round === 2);
    fireTurnExpiry(roomId);

    const state = await advanced;
    expect(state.currentPlayerIndex).toBe(0);
    const chartValues = nonNull(state.chartValues);
    expect(chartValues[0].length).toBe(2);
    expect(chartValues[1].length).toBe(2);
    expect(state.chartLabels).toEqual([1]); // round at the moment it ended

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('game-over via timeout finishes the game and schedules no further timer', async () => {
    const roomId = 'timer-gameover';
    const { sock } = await joinRoom(roomId, 'Solo');

    // winningScore must respect the same MIN_WINNING_SCORE floor as updateConfig
    // (pushState is no longer a side door for smaller values).
    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 1000 };

    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 1000, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);

    const finishedState = waitForState(sock, (s) => s.finished === true);
    fireTurnExpiry(roomId);

    const state = await finishedState;
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.currentCard).toBeNull();

    // No further auto-advance once the game is over.
    expectNoTimerArmed(roomId);

    sock.disconnect();
  });

  it('updateConfig turnDuration=0 mid-turn cancels a pending expiry', async () => {
    const roomId = 'timer-config-cancel';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    // pushState rather than updateConfig to start the turn, so the arming and
    // the cancelling below come from different paths — updateConfig is the one
    // under test, and a turn it also started would not prove it clears an
    // expiry it did not arm.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: twoPlayers(roomId, hostSock, guestSock), status: 'playing',
        currentPlayerIndex: 0, currentCard: '200', cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    // The timer this test goes on to cancel — confirmed armed, not assumed.
    await waitForArmedTimer(roomId);

    hostSock.emit('updateConfig', { roomId, turnDuration: 0 });
    await waitForState(hostSock, (s) => s.turnDuration === 0);

    // If updateConfig didn't resync (clear) the pending expiry, the original
    // timeout would still be sitting here waiting to fire.
    expectNoTimerArmed(roomId);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  it('kicking the active player reschedules the underlying expiry timer, not just the displayed time', async () => {
    const roomId = 'timer-kick-reschedule';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: bobSock, socketId: bobId } = await joinRoom(roomId, 'Bob');
    const { sock: carolSock } = await joinRoom(roomId, 'Carol');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: bobSock.id, disconnected: false, score: 0 },
      { name: 'Carol', deviceId: `dev-${roomId}-Carol`, socketId: carolSock.id, disconnected: false, score: 0 },
    ];

    // Bob (index 1) is the active player.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: '200',
        cards: ['300', '400'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);
    const timerBeforeKick = rooms[normalizeRoomId(roomId)].turnExpireTimer;

    // Host kicks Bob mid-turn. Bob wasn't last in turn order (Carol, at index 2,
    // hasn't gone yet this round) so the round must NOT bump — Carol simply
    // inherits Bob's slot (shifted down to index 1) and gets a fresh window.
    const kickedState = waitForState(hostSock, (s) => s.players?.length === 2 && s.currentPlayerIndex === 1);
    hostSock.emit('kickPlayer', bobId);
    bobSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.round).toBe(1); // no round skip — Carol still owed a turn this round
    expect(afterKick.currentPlayerIndex).toBe(1); // Carol, shifted into Bob's old slot

    // The actual point of the test, now stated directly rather than inferred
    // from a stale timer failing to fire inside a 200ms window: the pending
    // setTimeout was REPLACED, and the window it was replaced with is a full
    // fresh turn rather than the remainder of Bob's.
    expect(rooms[normalizeRoomId(roomId)].turnExpireTimer).not.toBeNull();
    expect(rooms[normalizeRoomId(roomId)].turnExpireTimer).not.toBe(timerBeforeKick);
    expect(afterKick.turnTimeRemaining).toBe(TURN_DURATION_S);

    // Carol is now last in turn order (2 players remain), so her forced timeout
    // completes the round, wrapping to round 2.
    const wrapped = waitForState(hostSock, (s) => s.round === 2);
    fireTurnExpiry(roomId);
    expect(nonNull((await wrapped).players).length).toBe(2);

    hostSock.disconnect();
    carolSock.disconnect();
  });

  it('kicking the active player who is last in turn order still bumps the round', async () => {
    const roomId = 'timer-kick-last-in-order';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: bobSock } = await joinRoom(roomId, 'Bob');
    const { sock: carolSock, socketId: carolId } = await joinRoom(roomId, 'Carol');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: bobSock.id, disconnected: false, score: 0 },
      { name: 'Carol', deviceId: `dev-${roomId}-Carol`, socketId: carolSock.id, disconnected: false, score: 0 },
    ];

    // Carol (index 2) is the active player — the last in turn order this round.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 2, currentCard: '200',
        cards: ['300', '400'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });

    // Kicking her should complete the round immediately, unlike kicking a
    // mid-order player — nobody else was still owed a turn this round.
    const kickedState = waitForState(hostSock, (s) => s.players?.length === 2);
    hostSock.emit('kickPlayer', carolId);
    carolSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.round).toBe(2);
    expect(afterKick.currentPlayerIndex).toBe(0); // wraps back to Alice

    hostSock.disconnect();
    bobSock.disconnect();
  });

  it('kicking the active player clears their live dice snapshot from room state', async () => {
    const roomId = 'timer-kick-livestate';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: bobSock, socketId: bobId } = await joinRoom(roomId, 'Bob');
    const { sock: carolSock } = await joinRoom(roomId, 'Carol');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: bobSock.id, disconnected: false, score: 0 },
      { name: 'Carol', deviceId: `dev-${roomId}-Carol`, socketId: carolSock.id, disconnected: false, score: 0 },
    ];

    // Bob (index 1) is mid-turn with a live dice snapshot that spectators render.
    const liveTurnState = {
      turnScore: 350, keptDice: [{ id: 'd1', val: 1 }], currentRoll: [],
      kniffelProgress: [], tuttosThisTurn: 0,
    };
    const setup = waitForState(hostSock, (s) => s.liveTurnState?.turnScore === 350);
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: '200',
        cards: ['300', '400'], round: 1, turnDuration: TURN_DURATION_S, liveTurnState,
      },
    });
    await setup;

    // Kicking Bob must drop his snapshot — otherwise the remaining players keep
    // seeing Bob's dice attributed to Carol, who inherits his turn slot.
    const kickedState = waitForState(hostSock, (s) => s.players?.length === 2);
    hostSock.emit('kickPlayer', bobId);
    bobSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.liveTurnState).toBeNull();
    expect(afterKick.currentPlayerIndex).toBe(1); // Carol, shifted into Bob's slot

    hostSock.disconnect();
    carolSock.disconnect();
  });

  it('deleting a room while a turn timer is pending does not crash the server', async () => {
    const roomId = 'timer-room-deleted';
    const { sock } = await joinRoom(roomId, 'Solo');

    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 0 };

    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 1000, turnDuration: TURN_DURATION_S,
      },
    });
    await waitForArmedTimer(roomId);

    // Captured while the room still exists: deleteRoom clears this handle, and a
    // cleared handle has no callback left to run. Holding the closure is what
    // lets the orphaned expiry below be run at all — the old version instead
    // slept past the real deadline and inferred from the server still answering
    // that it had fired.
    const orphaned = (rooms[normalizeRoomId(roomId)].turnExpireTimer as unknown as { _onTimeout: () => void })._onTimeout;

    // Player explicitly leaves — room.state.players becomes empty and the room
    // is deleted with this expiry still pending.
    sock.emit('leaveRoom');
    await waitFor(() => rooms[normalizeRoomId(roomId)] === undefined);
    sock.disconnect();

    // The orphaned expiry now runs against a room that no longer exists. In the
    // spawned version an uncaught throw here killed the server and the next
    // join failed; in-process it would reject this call directly.
    expect(() => orphaned()).not.toThrow();

    // ...and the server still seats new players afterwards.
    const { state, sock: freshSock } = await joinRoom('timer-room-deleted-followup', 'Fresh');
    expect(state.status).toBe('lobby');
    freshSock.disconnect();
  });

  it('explicitly finishing the game clears any pending turn-expiry timer', async () => {
    const roomId = 'timer-explicit-finish';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = twoPlayers(roomId, hostSock, guestSock);

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: 'Kleeblatt',
        cards: ['300'], round: 1, turnDuration: TURN_DURATION_S,
      },
    });
    // The turn whose pending expiry this test is about — confirmed, not assumed.
    await waitForArmedTimer(roomId);

    // Alice completes Kleeblatt for an instant win — client pushes finished:true
    // while the timer armed for the ORIGINAL Kleeblatt turn is still pending.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: [
          { ...players[0], score: 6000, timesKleeblattCompleted: 1 },
          players[1],
        ],
        finished: true, currentPlayerIndex: null, currentCard: null,
      },
    });

    await waitForState(hostSock, (s) => s.finished === true);

    // That pending timer must be gone, not merely late — otherwise it fires and
    // forces a bogus "timeout advance" on top of an already-finished game.
    expectNoTimerArmed(roomId);

    hostSock.disconnect();
    guestSock.disconnect();
  });
});
