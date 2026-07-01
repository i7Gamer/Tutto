/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { io } from 'socket.io-client';

// Covers the server-authoritative turn timer (server/index.ts: startServerTurnTimer /
// advanceTurnOnTimeout / clearServerTurnTimer). Before this feature, turn expiry was
// driven exclusively by the host's client-side setInterval, which stalled the game if
// the host disconnected, closed their tab, or the tab was backgrounded/throttled.
describe('Server-side turn timer', () => {
  let serverProcess;
  const PORT = '3010';

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: {
          ...process.env,
          PORT,
          VITE_API_TOKEN: 'test-token',
          TEST_DB: 'true',
          FORCE_INIT_DB: 'true',
        },
        stdio: 'pipe',
      });
      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Database migrated')) resolve();
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
    await delay(200);

    hostSock.disconnect();
    guestSock.disconnect();

    // Give the server time to run advanceTurnOnTimeout with zero sockets attached.
    await delay(1500);

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

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 2000);
    const state = await waitForState(hostSock, (s) => s.currentPlayerIndex === 1, 3000);
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

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 1300);
    const state = await waitForState(hostSock, (s) => s.currentPlayerIndex === 1, 2500);
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

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 1800);

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

    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 100 };

    const finishedState = waitForState(sock, (s) => s.finished === true, 5000);
    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 100, turnDuration: 1,
      },
    });

    const state = await finishedState;
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.currentCard).toBeNull();

    // No further auto-advance should occur once the game is over.
    await expectNoAdvanceWithin(sock, (s) => s.currentCard !== null || s.currentPlayerIndex !== null, 2000);

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
    await delay(200);

    // Disable the timer before the 1s deadline. If updateConfig didn't resync
    // (clear) the pending expiry, the original timeout would still fire ~800ms later.
    hostSock.emit('updateConfig', { roomId, turnDuration: 0 });

    await expectNoAdvanceWithin(hostSock, (s) => s.currentPlayerIndex === 1, 2000);

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
    await delay(1200); // ~1.2s of Bob's 2s turn has elapsed

    // Host kicks Bob mid-turn. handleActivePlayerRemoved immediately bumps round to 2
    // and resets turnStartTime for whoever now occupies index 1 (Carol) — a fresh 2s
    // window starting at the kick. The server must reschedule the actual pending
    // setTimeout to match this fresh window, not just the turnStartTime field.
    const kickedState = waitForState(hostSock, (s) => s.round === 2, 3000);
    hostSock.emit('kickPlayer', bobId);
    bobSock.disconnect();
    const afterKick = await kickedState;
    expect(afterKick.currentPlayerIndex).toBe(1); // Carol, shifted into Bob's old slot

    // Carol's forced timeout (if/when it fires) wraps the round again, to round 3.
    // If the reschedule didn't happen, the STALE timer (armed at t=0 for the
    // ORIGINAL 2s window, ~0.8s remaining at kick time) would fire ~800ms after
    // the kick and force this prematurely. It must not.
    await expectNoAdvanceWithin(hostSock, (s) => s.round === 3, 1200);

    // ~2s after the kick, Carol's rescheduled turn must have expired.
    const state = await waitForState(hostSock, (s) => s.round === 3, 2500);
    expect(state.players.length).toBe(2);

    hostSock.disconnect();
    carolSock.disconnect();
  }, 12000);

  it('deleting a room while a turn timer is pending does not crash the server', async () => {
    const roomId = 'timer-room-deleted';
    const { sock } = await joinRoom(roomId, 'Solo');

    const player = { name: 'Solo', deviceId: `dev-${roomId}-Solo`, socketId: sock.id, disconnected: false, score: 0 };

    sock.emit('pushState', {
      roomId,
      newState: {
        players: [player], status: 'playing', currentPlayerIndex: 0, currentCard: '200',
        cards: ['300'], round: 1, winningScore: 100, turnDuration: 1,
      },
    });
    await delay(200);

    // Player explicitly leaves — room.state.players becomes empty, room is deleted
    // (advanceTurnOnTimeout's setTimeout for this room is still pending at this point).
    sock.emit('leaveRoom');
    sock.disconnect();

    // Wait past the original 1s deadline so the now-orphaned timeout fires.
    await delay(1500);

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
    await delay(200);

    // Alice completes Kleeblatt for an instant win — client pushes finished:true
    // well before the 1s turn timer (armed for the ORIGINAL Kleeblatt turn) expires.
    hostSock.emit('pushState', {
      roomId,
      newState: {
        players: [
          { ...players[0], score: 999999, timesKleeblattCompleted: 1 },
          players[1],
        ],
        finished: true, currentPlayerIndex: null, currentCard: null,
      },
    });

    // The pending 1s timer from the FIRST push must not fire and force a bogus
    // "timeout advance" on top of the already-finished game.
    await expectNoAdvanceWithin(hostSock, (s) => s.currentCard !== null, 1800);

    hostSock.disconnect();
    guestSock.disconnect();
  }, 8000);
});
