/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { io } from 'socket.io-client';
import { TEST_PORTS } from './testPorts';

describe('Socket updateConfig — upper-bound validation', () => {
  let serverProcess;
  const PORT = TEST_PORTS.socketConfigBounds;

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

  // Join a room as host and resolve once the server has emitted the initial gameState.
  const joinRoom = (roomId) =>
    new Promise((resolve, reject) => {
      const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
      sock.on('connect', () => {
        sock.emit(
          'joinRoom',
          { roomId, name: 'Host', deviceId: `dev-${roomId}`, color: '#ff0000' },
          (res) => {
            if (res.error) { sock.disconnect(); return reject(new Error(res.error)); }
            sock.once('gameState', (state) => resolve({ sock, state }));
          }
        );
      });
      sock.on('connect_error', reject);
    });

  // Send updateConfig and return the resulting gameState.
  const sendConfig = (sock, roomId, config) =>
    new Promise((resolve) => {
      sock.once('gameState', resolve);
      sock.emit('updateConfig', { roomId, ...config });
    });

  // ─── winningScore ────────────────────────────────────────────────────────────

  it('rejects winningScore above 99999', async () => {
    const { sock, state: initial } = await joinRoom('ws-room-1');
    expect(initial.winningScore).toBe(6000);
    const next = await sendConfig(sock, 'ws-room-1', { winningScore: 100000 });
    expect(next.winningScore).toBe(6000);
    sock.disconnect();
  });

  it('accepts winningScore exactly at 99999', async () => {
    const { sock } = await joinRoom('ws-room-2');
    const next = await sendConfig(sock, 'ws-room-2', { winningScore: 99999 });
    expect(next.winningScore).toBe(99999);
    sock.disconnect();
  });

  // ─── turnDuration ────────────────────────────────────────────────────────────

  it('rejects turnDuration above 600', async () => {
    const { sock, state: initial } = await joinRoom('ws-room-3');
    expect(initial.turnDuration).toBe(120);
    const next = await sendConfig(sock, 'ws-room-3', { turnDuration: 601 });
    expect(next.turnDuration).toBe(120);
    sock.disconnect();
  });

  it('accepts turnDuration exactly at 600', async () => {
    const { sock } = await joinRoom('ws-room-4');
    const next = await sendConfig(sock, 'ws-room-4', { turnDuration: 600 });
    expect(next.turnDuration).toBe(600);
    sock.disconnect();
  });

  // ─── reconnectTimeout ────────────────────────────────────────────────────────

  it('rejects reconnectTimeout above 3600', async () => {
    const { sock, state: initial } = await joinRoom('ws-room-5');
    expect(initial.reconnectTimeout).toBe(60);
    const next = await sendConfig(sock, 'ws-room-5', { reconnectTimeout: 3601 });
    expect(next.reconnectTimeout).toBe(60);
    sock.disconnect();
  });

  it('accepts reconnectTimeout exactly at 3600', async () => {
    const { sock } = await joinRoom('ws-room-6');
    const next = await sendConfig(sock, 'ws-room-6', { reconnectTimeout: 3600 });
    expect(next.reconnectTimeout).toBe(3600);
    sock.disconnect();
  });
});

describe('Socket security and timer fixes', () => {
  let serverProcess;
  const PORT = TEST_PORTS.socketSecurityTimers;

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

  const joinRoom = (roomId) =>
    new Promise((resolve, reject) => {
      const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
      sock.on('connect', () => {
        sock.emit(
          'joinRoom',
          { roomId, name: 'Host', deviceId: `dev-${roomId}`, color: '#ff0000' },
          (res) => {
            if (res.error) { sock.disconnect(); return reject(new Error(res.error)); }
            sock.once('gameState', (state) => resolve({ sock, state }));
          }
        );
      });
      sock.on('connect_error', reject);
    });

  const joinAsGuest = (roomId, name = 'Guest') =>
    new Promise((resolve, reject) => {
      const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
      sock.on('connect', () => {
        sock.emit(
          'joinRoom',
          { roomId, name, deviceId: `dev-${roomId}-${name}`, color: '#00ff00' },
          (res) => {
            if (res.error) { sock.disconnect(); return reject(new Error(res.error)); }
            resolve({ sock, socketId: res.socketId });
          }
        );
      });
      sock.on('connect_error', reject);
    });

  // ─── Issue 2: reorderPlayers duplication exploit ──────────────────────────

  it('rejects reorderPlayers that would create duplicate player entries', async () => {
    const roomId = 'sec-room-1';
    const { sock: hostSock } = await joinRoom(roomId);

    // Guest joins; host receives updated gameState
    const guestJoinedState = new Promise(r => hostSock.once('gameState', r));
    const { sock: guestSock } = await joinAsGuest(roomId, 'Guest');
    await guestJoinedState;

    // Exploit attempt: 3 entries using only valid names — the old Set-size check
    // passed because Set{Host,Guest}.size === Set{Host,Guest}.size, but this
    // would map to [HostObj, GuestObj, HostObj] (3 players, Host duplicated).
    hostSock.emit('reorderPlayers', {
      roomId,
      newPlayers: [{ name: 'Host' }, { name: 'Guest' }, { name: 'Host' }],
    });

    // Immediately follow with a valid reorder so we get a gameState to assert on.
    // Server processes socket events in order, so the exploit fires first.
    const stateAfterValidReorder = await new Promise(r => {
      hostSock.once('gameState', r);
      hostSock.emit('reorderPlayers', {
        roomId,
        newPlayers: [{ name: 'Guest' }, { name: 'Host' }],
      });
    });

    expect(stateAfterValidReorder.players.length).toBe(2);
    expect(stateAfterValidReorder.players[0].name).toBe('Guest');
    expect(stateAfterValidReorder.players[1].name).toBe('Host');

    hostSock.disconnect();
    guestSock.disconnect();
  });

  // ─── Issue 3: turn timer desync on kick ──────────────────────────────────

  it('resets turn timer when the active player is kicked mid-turn', async () => {
    const roomId = 'sec-room-2';
    const { sock: hostSock } = await joinRoom(roomId);

    // Guest joins
    const guestJoinedState = new Promise(r => hostSock.once('gameState', r));
    const { sock: guestSock, socketId: guestId } = await joinAsGuest(roomId, 'Guest');
    await guestJoinedState;

    // A third player, so kicking Guest leaves a still-playable 2-player game
    // instead of aborting it — the turn-timer-reset behavior under test only
    // applies when the game continues with a new active player.
    const bystanderJoinedState = new Promise(r => hostSock.once('gameState', r));
    const { sock: bystanderSock } = await joinAsGuest(roomId, 'Bystander');
    await bystanderJoinedState;

    // Set turn duration to 60 s (valid range is 10-600)
    await new Promise(r => {
      hostSock.once('gameState', r);
      hostSock.emit('updateConfig', { roomId, turnDuration: 60 });
    });

    // Start game with guest (index 1) as the active player
    const playingState = await new Promise(r => {
      hostSock.once('gameState', r);
      hostSock.emit('pushState', {
        roomId,
        newState: { status: 'playing', currentPlayerIndex: 1, currentCard: 'Stop', round: 1 },
      });
    });
    expect(playingState.turnTimeRemaining).toBe(60);

    // Age the timer by 400ms+ (with TEST_TIMER_SCALE=0.2, turnDuration 60 becomes 12s)
    // so the stale baseline is measurably different from a fresh reset.
    await new Promise(r => setTimeout(r, 450));

    // Host kicks the active player — fix resets turnStartTime to Date.now()
    const stateAfterKick = await new Promise(r => {
      hostSock.once('gameState', r);
      hostSock.emit('kickPlayer', guestId);
    });

    // Without fix: turnTimeRemaining = 60 - 2 = 58 (<59, fails)
    // With fix:    turnTimeRemaining = 60 - 0 = 60 (>=59, passes)
    expect(stateAfterKick.turnTimeRemaining).toBeGreaterThanOrEqual(59);

    hostSock.disconnect();
    guestSock.disconnect();
    bystanderSock.disconnect();
  }, 15000);

  // ─── pushState config sanity guard ─────────────────────────────────────────

  it('ignores insane config values arriving via pushState instead of applying them', async () => {
    const roomId = 'sec-room-3';
    const { sock: hostSock, state: initial } = await joinRoom(roomId);
    expect(initial.turnDuration).toBe(120);

    // A negative turnDuration would make the server-side turn timer re-arm
    // with remaining<=0 and advance turns in a synchronous loop; NaN and junk
    // initialCards would corrupt win checks and deck rebuilds. All must be
    // dropped while the valid fields in the same push still apply.
    const next = await new Promise(r => {
      hostSock.once('gameState', r);
      hostSock.emit('pushState', {
        roomId,
        newState: {
          turnDuration: -1,
          winningScore: NaN,
          reconnectTimeout: 1e12,
          randomOrder: 'yes',
          status: 'garbage',
          initialCards: { '200': 1e9, Bogus: 3 },
          round: 2,
        },
      });
    });

    expect(next.turnDuration).toBe(120);
    expect(next.winningScore).toBe(6000);
    expect(next.reconnectTimeout).toBe(60);
    expect(next.randomOrder).toBe(true);
    expect(next.status).toBe('lobby');
    expect(next.initialCards['200']).toBe(5);
    expect(next.round).toBe(2); // the valid field in the same push still applies

    hostSock.disconnect();
  });
});
