/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { io } from 'socket.io-client';
import { TEST_PORTS } from './testPorts';

// Covers the server-authoritative turn timer (server/index.ts: startServerTurnTimer /
// advanceTurnOnTimeout / clearServerTurnTimer). Before this feature, turn expiry was
// driven exclusively by the host's client-side setInterval, which stalled the game if
// the host disconnected, closed their tab, or the tab was backgrounded/throttled.
describe('Server-side turn timer', () => {
  let serverProcess;
  const PORT = TEST_PORTS.turnTimer;

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: {
          ...process.env,
          PORT,
          API_TOKEN: 'test-token',
          TEST_DB: 'true',
          FORCE_INIT_DB: 'true',
          TEST_TIMER_SCALE: '0.2',
        },
        stdio: 'pipe',
      });
      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) resolve();
      });
      serverProcess.stderr.on('data', (data) => console.error('[server]', data.toString()));
      serverProcess.on('error', reject);
    });
  }, 20000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const joinRoom = (roomId, name = 'Host') =>
    new Promise((resolve, reject) => {
      const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
      sock.on('connect', () => {
        sock.emit(
          'joinRoom',
          { roomId, name, deviceId: `dev-${roomId}-${name}`, color: '#ff0000' },
          (res) => {
            if (res.error) { sock.disconnect(); return reject(new Error(res.error)); }
            sock.once('gameState', (state) => resolve({ sock, socketId: res.socketId, state }));
          }
        );
      });
      sock.on('connect_error', reject);
    });

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Resolves with the first gameState matching predicate, or rejects on timeout.
  const waitForState = (sock, predicate, timeoutMs = 6000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.off('gameState', handler);
        reject(new Error('Timed out waiting for expected gameState'));
      }, timeoutMs);
      const handler = (state) => {
        if (predicate(state)) {
          clearTimeout(timer);
          sock.off('gameState', handler);
          resolve(state);
        }
      };
      sock.on('gameState', handler);
    });

  // Opposite of waitForState: fails if predicate ever matches within the window.
  const expectNoAdvanceWithin = (sock, predicate, ms) =>
    new Promise((resolve, reject) => {
      const handler = (state) => {
        if (predicate(state)) {
          sock.off('gameState', handler);
          reject(new Error('Turn advanced earlier than expected'));
        }
      };
      sock.on('gameState', handler);
      setTimeout(() => {
        sock.off('gameState', handler);
        resolve();
      }, ms);
    });

  it('server auto-advances the turn when it expires, without any client action', async () => {
    const roomId = 'timer-basic';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    const advanced = waitForState(hostSock, (s) => s.currentPlayerIndex === 1, 5000);
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, turnDuration: 1,
      },
    });

    const state = await advanced;
    expect(state.previousCard).toBe('200');
    expect(state.previousScore).toBe(0);
    const alice = state.players.find(p => p.name === 'Alice');
    expect(alice.busts).toBe(1); // no manual action was taken → counts as a bust, like a real timeout
    expect(state.historyLog).toBeDefined();
    expect(state.historyLog.length).toBe(1);
    expect(state.historyLog[0].playerName).toBe('Alice');
    expect(state.historyLog[0].type).toBe('bust');
    expect(state.historyLog[0].card).toBe('200');

    hostSock.disconnect();
    guestSock.disconnect();
  }, 10000);

  it('turn still advances after the host disconnects mid-turn', async () => {
    const roomId = 'timer-host-gone';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    const advanced = waitForState(guestSock, (s) => s.round === 2, 5000);

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: 'Stop',
        cards: ['200'], round: 1, turnDuration: 1,
      },
    });
    await delay(200);
    hostSock.disconnect(); // host is gone entirely — no client left to "own" the turn

    const state = await advanced;
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.status).toBe('playing');

    guestSock.disconnect();
  }, 10000);

  it('turn still advances even when every client has disconnected', async () => {
    const roomId = 'timer-empty-room';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, turnDuration: 1,
      },
    });
    await delay(50);

    hostSock.disconnect();
    guestSock.disconnect();

    // Give the server time to run advanceTurnOnTimeout with zero sockets attached.
    await delay(250);

    // Reconnect as Alice (same deviceId) to observe the room's current state.
    const { state } = await joinRoom(roomId, 'Alice');
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.previousCard).toBe('200');
  }, 10000);

  it('Feuerwerk applies a 3x turn duration multiplier', async () => {
    const roomId = 'timer-feuerwerk';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: 'Feuerwerk',
        cards: ['300'], round: 1, turnDuration: 1, // target = 1 * 3 = 3s
      },
    });

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 300);
    const state = await waitForState(hostSock, (s) => s.currentPlayerIndex === 1, 1000);
    expect(state.previousCard).toBe('Feuerwerk');

    hostSock.disconnect();
    guestSock.disconnect();
  }, 10000);

  it('Kleeblatt applies a 2x turn duration multiplier', async () => {
    const roomId = 'timer-kleeblatt';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: 'Kleeblatt',
        cards: ['300'], round: 1, turnDuration: 1, // target = 1 * 2 = 2s
      },
    });

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 200);
    const state = await waitForState(hostSock, (s) => s.currentPlayerIndex === 1, 800);
    expect(state.previousCard).toBe('Kleeblatt');

    hostSock.disconnect();
    guestSock.disconnect();
  }, 10000);

  it('turnDuration=0 disables the server timer entirely', async () => {
    const roomId = 'timer-disabled';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, turnDuration: 0,
      },
    });

    // Confirm the setup actually landed before asserting that nothing happens.
    // A rejected push would leave a room with no turn and no timer, where "the
    // turn never advanced" holds for reasons that have nothing to do with
    // turnDuration=0.
    await waitForState(hostSock, (s) => s.status === 'playing' && s.turnDuration === 0 && s.currentPlayerIndex === 0);

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 400);

    hostSock.disconnect();
    guestSock.disconnect();
  }, 8000);

  it('round-end via timeout updates chartValues/chartLabels and wraps to the next round', async () => {
    const roomId = 'timer-round-end';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    const advanced = waitForState(hostSock, (s) => s.round === 2, 5000);
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: '300',
        cards: ['200'], round: 1, turnDuration: 1,
        chartValues: [[0], [0]], chartNames: ['Alice', 'Bob'], chartLabels: [],
      },
    });

    const state = await advanced;
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.chartValues[0].length).toBe(2);
    expect(state.chartValues[1].length).toBe(2);
    expect(state.chartLabels).toEqual([1]); // round at the moment it ended

    hostSock.disconnect();
    guestSock.disconnect();
  }, 10000);

  it('game-over via timeout finishes the game and schedules no further timer', async () => {
    const roomId = 'timer-gameover';
    const { sock } = await joinRoom(roomId, 'Solo');

    // winningScore must respect the same MIN_WINNING_SCORE floor as updateConfig
    // (pushState is no longer a side door for smaller values).
    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 1000 };

    const finishedState = waitForState(sock, (s) => s.finished === true, 5000);
    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 1000, turnDuration: 1,
      },
    });

    const state = await finishedState;
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.currentCard).toBeNull();

    // No further auto-advance should occur once the game is over.
    await expectNoAdvanceWithin(sock, (s) => s.currentCard !== null || s.currentPlayerIndex !== null, 400);

    sock.disconnect();
  }, 10000);

  it('updateConfig turnDuration=0 mid-turn cancels a pending expiry', async () => {
    const roomId = 'timer-config-cancel';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    // Start a 1s turn (bypassing updateConfig's 10s floor via pushState, matching
    // the existing test-speed convention used elsewhere in this suite).
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, turnDuration: 1,
      },
    });
    // Waited for rather than slept past: this is the state that arms the timer
    // the test goes on to cancel, so nothing below means anything until the
    // server confirms it.
    await waitForState(hostSock, (s) => s.status === 'playing' && s.turnDuration === 1 && s.currentPlayerIndex === 0);

    // Disable the timer before the deadline. If updateConfig didn't resync
    // (clear) the pending expiry, the original timeout would still fire ~150ms later.
    hostSock.emit('updateConfig', { roomId, turnDuration: 0 });
    await waitForState(hostSock, (s) => s.turnDuration === 0);

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 400);

    hostSock.disconnect();
    guestSock.disconnect();
  }, 8000);

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

    // Bob (index 1) is the active player with a 2s turn.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: '200',
        cards: ['300', '400'], round: 1, turnDuration: 2,
      },
    });
    await delay(200); // ~200ms of Bob's 400ms turn has elapsed

    // Host kicks Bob mid-turn. Bob wasn't last in turn order (Carol, at index 2,
    // hasn't gone yet this round) so the round must NOT bump — Carol simply
    // inherits Bob's slot (shifted down to index 1) and gets a fresh 2s window.
    // The server must reschedule the actual pending setTimeout to match that
    // fresh window, not just the turnStartTime field.
    const kickedState = waitForState(hostSock, (s) => s.players.length === 2 && s.currentPlayerIndex === 1, 3000);
    hostSock.emit('kickPlayer', bobId);
    bobSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.round).toBe(1); // no round skip — Carol still owed a turn this round
    expect(afterKick.currentPlayerIndex).toBe(1); // Carol, shifted into Bob's old slot

    // Carol is now last in turn order (2 players remain), so her forced timeout
    // completes the round, wrapping to round 2. If the reschedule didn't happen,
    // the STALE timer (armed at t=0 for the ORIGINAL 2s window, ~0.8s remaining
    // at kick time) would fire ~800ms after the kick and force this prematurely.
    await expectNoAdvanceWithin(hostSock, (s) => s.round === 2, 200);

    // ~400ms after the kick, Carol's rescheduled turn must have expired.
    const state = await waitForState(hostSock, (s) => s.round === 2, 1000);
    expect(state.players.length).toBe(2);

    hostSock.disconnect();
    carolSock.disconnect();
  }, 12000);

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
        cards: ['300', '400'], round: 1, turnDuration: 30,
      },
    });

    // Kicking her should complete the round immediately, unlike kicking a
    // mid-order player — nobody else was still owed a turn this round.
    const kickedState = waitForState(hostSock, (s) => s.players.length === 2, 3000);
    hostSock.emit('kickPlayer', carolId);
    carolSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.round).toBe(2);
    expect(afterKick.currentPlayerIndex).toBe(0); // wraps back to Alice

    hostSock.disconnect();
    bobSock.disconnect();
  }, 10000);

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
    const setup = waitForState(hostSock, (s) => s.liveTurnState?.turnScore === 350, 3000);
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 1, currentCard: '200',
        cards: ['300', '400'], round: 1, turnDuration: 30, liveTurnState,
      },
    });
    await setup;

    // Kicking Bob must drop his snapshot — otherwise the remaining players keep
    // seeing Bob's dice attributed to Carol, who inherits his turn slot.
    const kickedState = waitForState(hostSock, (s) => s.players.length === 2, 3000);
    hostSock.emit('kickPlayer', bobId);
    bobSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.liveTurnState).toBeNull();
    expect(afterKick.currentPlayerIndex).toBe(1); // Carol, shifted into Bob's slot

    hostSock.disconnect();
    carolSock.disconnect();
  }, 10000);

  it('deleting a room while a turn timer is pending does not crash the server', async () => {
    const roomId = 'timer-room-deleted';
    const { sock } = await joinRoom(roomId, 'Solo');

    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 0 };

    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 1000, turnDuration: 1,
      },
    });
    await delay(200);

    // Player explicitly leaves — room.state.players becomes empty, room is deleted
    // (advanceTurnOnTimeout's setTimeout for this room is still pending at this point).
    sock.emit('leaveRoom');
    sock.disconnect();

    // Wait past the original deadline so the now-orphaned timeout fires.
    await delay(250);

    // Prove the server process is still alive and responsive.
    const { state } = await joinRoom('timer-room-deleted-followup', 'Fresh');
    expect(state.status).toBe('lobby');
  }, 8000);

  it('explicitly finishing the game clears any pending turn-expiry timer', async () => {
    const roomId = 'timer-explicit-finish';
    const { sock: hostSock } = await joinRoom(roomId, 'Alice');
    const { sock: guestSock } = await joinRoom(roomId, 'Bob');

    const players = [
      { name: 'Alice', deviceId: `dev-${roomId}-Alice`, socketId: hostSock.id, disconnected: false, score: 0 },
      { name: 'Bob', deviceId: `dev-${roomId}-Bob`, socketId: guestSock.id, disconnected: false, score: 0 },
    ];

    hostSock.emit('pushState', {
      roomId,
      newState: {
        players, status: 'playing', currentPlayerIndex: 0, currentCard: 'Kleeblatt',
        cards: ['300'], round: 1, turnDuration: 1,
      },
    });
    // The turn whose pending expiry this test is about — confirmed, not assumed.
    await waitForState(hostSock, (s) => s.status === 'playing' && s.currentCard === 'Kleeblatt');

    // Alice completes Kleeblatt for an instant win — client pushes finished:true
    // well before the 1s turn timer (armed for the ORIGINAL Kleeblatt turn) expires.
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

    // The pending 1s timer from the FIRST push must not fire and force a bogus
    // "timeout advance" on top of the already-finished game.
    await expectNoAdvanceWithin(hostSock, (s) => s.currentCard !== null, 400);

    hostSock.disconnect();
    guestSock.disconnect();
  }, 8000);
});
