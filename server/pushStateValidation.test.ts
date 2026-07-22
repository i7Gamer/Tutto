/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { spawn } from 'child_process';

// Regression coverage for three related fixes to server/index.ts:
//  1. pushState previously trusted several fields (currentPlayerIndex, chartValues,
//     etc.) with no shape/range validation, which could crash the whole process
//     (every room) when the server-authoritative turn timer later read them.
//  2. gameState broadcasts included every player's deviceId — deviceId is the
//     credential that lets a reconnect take over a seat, so leaking it let any
//     room member hijack any other member's seat (and host role).
//  3. Aborting a game (drops below 2 players) didn't reset the room's elapsed-time
//     clock, so the next game in the same room inherited the old game's runtime.
describe('pushState validation, seat-hijack, and abort-clock fixes', () => {
  let serverProcess;
  const PORT = '3011';

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, API_TOKEN: 'test-token', TEST_DB: 'true', FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
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

  const joinRoom = (roomId, name, deviceId) =>
    new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => reject(new Error(`join timed out for ${name}`)), 5000);
      s.on('connect', () => {
        s.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res) => {
          clearTimeout(timeoutId);
          if (!res.success) return reject(new Error(res.error));
          resolve(s);
        });
      });
    });

  it('ignores an out-of-range currentPlayerIndex and keeps the server-side turn timer alive afterward', () => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 15000);
      let s1, s2;

      (async () => {
        const roomId = 'DOS_INDEX_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-dos-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-dos-b');

        let sawValidState = false;
        let sawTimerAdvance = false;

        s1.on('gameState', (state) => {
          if (state.currentPlayerIndex === 5000) {
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            reject(new Error('currentPlayerIndex 5000 was accepted — validation regressed'));
            return;
          }
          if (state.status === 'playing' && state.currentPlayerIndex === 0 && !sawValidState) {
            sawValidState = true;
            // A malformed push that should be entirely dropped.
            s1.emit('pushState', { roomId, newState: { currentPlayerIndex: 5000 } });
          }
          // If the process had crashed, no further turn-advance state would ever
          // arrive — reaching a second player's turn proves the timer fired safely.
          if (sawValidState && state.currentPlayerIndex === 1 && !sawTimerAdvance) {
            sawTimerAdvance = true;
            expect(state.currentPlayerIndex).toBe(1);
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            resolve();
          }
        });

        const players = [
          { name: 'Alice', deviceId: 'dev-dos-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-dos-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0, currentCard: '200', turnDuration: 1 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 17000);

  it('ignores malformed chartValues/chartLabels without crashing or corrupting room state', () => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1, s2;

      (async () => {
        const roomId = 'DOS_CHART_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-chart-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-chart-b');

        let pushedBad = false;

        s1.on('gameState', (state) => {
          if (state.status === 'playing' && !pushedBad) {
            pushedBad = true;
            s1.emit('pushState', {
              roomId,
              newState: { chartValues: { hacked: true }, chartLabels: 'not-an-array' },
            });
            // Prove liveness with a normal, valid follow-up push.
            setTimeout(() => s1.emit('pushState', { roomId, newState: { round: 2 } }), 200);
          }
          if (state.round === 2) {
            expect(Array.isArray(state.chartValues)).toBe(true);
            expect(Array.isArray(state.chartLabels)).toBe(true);
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            resolve();
          }
        });

        const players = [
          { name: 'Alice', deviceId: 'dev-chart-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-chart-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', {
          roomId,
          newState: { players, status: 'playing', currentPlayerIndex: 0, chartValues: [[], []], chartNames: ['Alice', 'Bob'] },
        });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 10000);

  it('never includes deviceId on any player in a gameState broadcast', () => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1, s2;

      (async () => {
        const roomId = 'HIJACK_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-hijack-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-hijack-b');

        s2.on('gameState', (state) => {
          if (state.players?.length !== 2) return;
          for (const p of state.players) {
            expect('deviceId' in p).toBe(false);
          }
          if (state.previousLeaders) {
            for (const p of state.previousLeaders) {
              expect('deviceId' in p).toBe(false);
            }
          }
          clearTimeout(timeoutId);
          s1.disconnect(); s2.disconnect();
          resolve();
        });

        const players = [
          { name: 'Alice', deviceId: 'dev-hijack-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-hijack-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 10000);

  it('does not carry a stale game clock from an aborted game into the next game in the same room', () => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 10000);
      let s1, s2;

      (async () => {
        const roomId = 'ABORT_CLOCK_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-ac-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-ac-b');

        const players = [
          { name: 'Alice', deviceId: 'dev-ac-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-ac-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });

        // Let the first game's clock accumulate >200ms of runtime before aborting it,
        // so a leaked gameActualStartTime is distinguishable from a fresh one.
        await new Promise((r) => setTimeout(r, 350));

        let restarted = false;
        s1.on('gameState', (state) => {
          if (state.status === 'lobby' && state.players?.length === 1 && !restarted) {
            restarted = true;
            (async () => {
              const s2b = await joinRoom(roomId, 'Bob', 'dev-ac-b');
              const restartPlayers = [
                { name: 'Alice', deviceId: 'dev-ac-a', socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob', deviceId: 'dev-ac-b', socketId: s2b.id, disconnected: false, score: 0 },
              ];
              s1.emit('pushState', { roomId, newState: { players: restartPlayers, status: 'playing', currentPlayerIndex: 0 } });

              s1.once('gameState', (freshState) => {
                // Without the fix, this reads >=1 (the old game's accumulated time).
                expect(freshState.gameTimeInSeconds).toBeLessThan(1);
                clearTimeout(timeoutId);
                s1.disconnect(); s2b.disconnect();
                resolve();
              });
            })().catch((err) => { clearTimeout(timeoutId); reject(err); });
          }
        });

        s2.emit('leaveRoom');
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 12000);
});
