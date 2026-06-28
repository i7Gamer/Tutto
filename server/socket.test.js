/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { io } from 'socket.io-client';

describe('Socket updateConfig — upper-bound validation', () => {
  let serverProcess;
  const PORT = '3008';

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn('node', ['server/index.js'], {
        env: {
          ...process.env,
          PORT,
          TUTTO_API_TOKEN: 'test-token',
          TEST_DB: 'true',
          FORCE_INIT_DB: 'true',
        },
        stdio: 'pipe',
      });
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Database migrated')) resolve();
      });
      serverProcess.stderr.on('data', (data) => console.error('[server]', data.toString()));
      serverProcess.on('error', reject);
    });
  }, 10000);

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
