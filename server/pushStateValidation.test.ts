/**
 * @vitest-environment node
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { asserting, startTestServer, type JoinAck } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import type { GameStore } from '../src/store/storeTypes';

// The shape of a 'gameState' broadcast, matching how the client itself types
// it (src/store/socketSlice.ts's own 'gameState' handler) — a broadcast only
// ever carries a subset of GameStore, plus the ordering counter that is not
// part of the store itself. Kept local to the .test.ts files that need it
// (rather than in socketTestHarness.ts) because that file — unlike this one —
// is part of tsconfig.server.json's production build, which checks under a
// narrower lib/environment than tsconfig.test.json and cannot resolve
// storeTypes.ts's zustand/immer middleware typing.
type GameStatePayload = Partial<GameStore> & { stateVersion?: number };

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
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.pushStateValidation;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT, { env: { API_TOKEN: 'test-token' } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const joinRoom = (roomId: string, name: string, deviceId: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => reject(new Error(`join timed out for ${name}`)), 5000);
      s.on('connect', () => {
        s.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => {
          clearTimeout(timeoutId);
          if (!res.success) return reject(new Error(res.error));
          resolve(s);
        });
      });
    });

  it('ignores an out-of-range currentPlayerIndex and keeps the server-side turn timer alive afterward', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 15000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'DOS_INDEX_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-dos-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-dos-b');

        let sawValidState = false;
        let sawTimerAdvance = false;

        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
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
        }));

        const players = [
          { name: 'Alice', deviceId: 'dev-dos-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-dos-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0, currentCard: '200', turnDuration: 1 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 17000);

  it('ignores malformed chartValues/chartLabels without crashing or corrupting room state', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'DOS_CHART_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-chart-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-chart-b');

        let pushedBad = false;

        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
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
        }));

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
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'HIJACK_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-hijack-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-hijack-b');

        s2.on('gameState', asserting(reject, (state: GameStatePayload) => {
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
        }));

        const players = [
          { name: 'Alice', deviceId: 'dev-hijack-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-hijack-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 10000);

  it('does not carry a stale game clock from an aborted game into the next game in the same room', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 10000);
      let s1: ClientSocket, s2: ClientSocket;

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
        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
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
        }));

        s2.emit('leaveRoom');
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 12000);
});
