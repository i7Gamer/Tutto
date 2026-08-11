/**
 * @vitest-environment node
 *
 * Socket integration suite — statistics persistence.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { startTestServer, testDelay } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

describe('Server Socket E2E — statistics persistence', () => {
  let serverProcess;

  const PORT = TEST_PORTS.socketsStats;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('gameTimeInSeconds is reset when game returns to lobby', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'GAME_TIME_RESET';
      const s1 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let seenPlaying = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-gtr-a', color: '#ff0000' }, () => {
          s1.emit('pushState', {
            roomId,
            newState: {
              status: 'playing',
              currentCard: '200',
              cards: [],
              currentPlayerIndex: 0,
              round: 1,
              finished: false,
              gameTimeInSeconds: 0,
              players: [{ name: 'Alice', deviceId: 'dev-gtr-a', score: 0 }],
            }
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'playing' && !seenPlaying) {
          seenPlaying = true;
          expect(state.gameTimeInSeconds).toBeLessThan(5);

          setTimeout(() => {
            s1.emit('pushState', {
              roomId,
              newState: {
                status: 'lobby',
                currentCard: null,
                cards: [],
                currentPlayerIndex: null,
                round: 1,
                finished: false,
                gameTimeInSeconds: 0,
                players: [{ name: 'Alice', deviceId: 'dev-gtr-a', score: 0 }],
              }
            });
          }, testDelay(100));
        } else if (state.status === 'lobby' && seenPlaying) {
          // Server snapshots authoritative time before clearing anchor; game ran <1s so value is 0
          expect(state.gameTimeInSeconds).toBe(0);
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  // 'gameTimeInSeconds on game-end is the server-calculated elapsed time...',
  // 'gameTimeInSeconds continues from correct server time on reconnect', and
  // 'gameActualStartTime is preserved across turn/card changes...' moved to
  // socketHandlers.test.ts's in-process 'game clock' suite for the same
  // reason as the monotonic test above.

  it('endGameStats accepts a write for the socket\'s own device', () => {
    return new Promise((resolve, reject) => {
      const deviceId = 'dev-egs-self';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 6000);

      // setupTests replaces global.fetch with a mock that only matches relative
      // URLs; the real implementation is preserved on global.__nativeFetch.
      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const pollStats = async () => {
        for (let i = 0; i < 50; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body && body.gamesPlayed >= 1) return body;
          await new Promise(r => setTimeout(r, 40));
        }
        return null;
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'EGS_SELF_ROOM', name: 'Alice', deviceId, color: '#ff0000' }, () => {
          // Stats are only accepted once the game has finished — stage a
          // started-and-finished game first (same-socket emits are ordered).
          s1.emit('pushState', { roomId: 'EGS_SELF_ROOM', newState: { status: 'playing', finished: true } });
          s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, wins: 1, totalScore: 1234 } });
          pollStats().then((body) => {
            try {
              expect(body).not.toBeNull();
              expect(body.gamesPlayed).toBeGreaterThanOrEqual(1);
              clearTimeout(timeoutId);
              s1.disconnect();
              resolve();
            } catch (e) {
              clearTimeout(timeoutId);
              s1.disconnect();
              reject(e);
            }
          });
        });
      });
    });
  }, 10000);

  it('records a custom game in its own bucket, leaving the normalized one and the global totals untouched', () => {
    // The one full-stack pass for the mode split: a real socket submission
    // against the real database, read back over the real HTTP API. The
    // handler-level tests mock the DB and the DB tests call it directly —
    // this is where the two provably meet.
    return new Promise<void>((resolve, reject) => {
      const deviceId = 'dev-egs-custom';
      const roomId = 'EGS_CUSTOM_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 9000);

      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const getJson = async (path: string) => (await realFetch(`http://127.0.0.1:${PORT}${path}`)).json();
      const poll = async <T,>(read: () => Promise<T | null>): Promise<T | null> => {
        for (let i = 0; i < 75; i++) {
          const value = await read();
          if (value) return value;
          await new Promise(r => setTimeout(r, 40));
        }
        return null;
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, async () => {
          try {
            const globalBefore = await getJson('/api/stats/global');

            // The custom config rides in on the opening push itself — the
            // lobby state never held it, which is exactly the case the
            // after-the-push mode evaluation exists for.
            s1.emit('pushState', { roomId, newState: { status: 'playing', finished: true, winningScore: 1000 } });
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, wins: 1, totalScore: 777 } });
            // The client claims it was a default game; the server knows better.
            s1.emit('submitGlobalStats', { roomId, payload: { gamesPlayed: 1, totalScore: 777, isDefaultGame: true } });

            const custom = await poll(async () => {
              const body = await getJson(`/api/stats/${deviceId}?mode=custom`);
              return body?.gamesPlayed >= 1 ? body : null;
            });
            expect(custom).not.toBeNull();
            expect(custom.totalScore).toBe(777);
            expect(custom.mode).toBe('custom');

            // The default read — what the lobby's win-streak lookup and every
            // old client sees — must not know this game happened.
            expect(await getJson(`/api/stats/${deviceId}`)).toEqual({});

            const globalAfter = await poll(async () => {
              const g = await getJson('/api/stats/global');
              return g.customGamesPlayed === (globalBefore.customGamesPlayed ?? 0) + 1 ? g : null;
            });
            expect(globalAfter).not.toBeNull();
            expect(globalAfter.totalGamesPlayed).toBe(globalBefore.totalGamesPlayed);
            expect(globalAfter.totalScore).toBe(globalBefore.totalScore);
            expect(globalAfter.defaultGamesPlayed).toBe(globalBefore.defaultGamesPlayed);

            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          } catch (e) {
            clearTimeout(timeoutId);
            s1.disconnect();
            reject(e);
          }
        });
      });
    });
  }, 10000);

  it('records a classic game in the classic buckets, and a classic custom game in classic_custom', () => {
    // The classic counterpart of the custom-game full-stack pass above: the
    // frozen ruleset picks the bucket PAIR, normalized-vs-custom picks within
    // it, and the global CLASSIC row is the only global row that moves.
    return new Promise<void>((resolve, reject) => {
      const deviceId = 'dev-egs-classic';
      const roomId = 'EGS_CLASSIC_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 9000);

      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const getJson = async (path: string) => (await realFetch(`http://127.0.0.1:${PORT}${path}`)).json();
      const poll = async <T,>(read: () => Promise<T | null>): Promise<T | null> => {
        for (let i = 0; i < 75; i++) {
          const value = await read();
          if (value) return value;
          await new Promise(r => setTimeout(r, 40));
        }
        return null;
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, async () => {
          try {
            const globalModernizedBefore = await getJson('/api/stats/global');
            const globalClassicBefore = await getJson('/api/stats/global?ruleset=classic');

            // A classic game on an otherwise DEFAULT config → the plain
            // 'classic' bucket and the classic global row's full sums.
            s1.emit('pushState', { roomId, newState: { status: 'playing', finished: true, ruleset: 'classic' } });
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, wins: 1, totalScore: 555, totalTuttos: 3, mostCardsInTurn: 2 } });
            s1.emit('submitGlobalStats', { roomId, payload: { gamesPlayed: 1, totalScore: 555, totalTuttos: 3, isDefaultGame: true } });

            const classic = await poll(async () => {
              const body = await getJson(`/api/stats/${deviceId}?mode=classic`);
              return body?.gamesPlayed >= 1 ? body : null;
            });
            expect(classic).not.toBeNull();
            expect(classic.totalScore).toBe(555);
            expect(classic.totalTuttos).toBe(3);
            expect(classic.mostCardsInTurn).toBe(2);
            expect(classic.mode).toBe('classic');

            // Neither modernized bucket knows this game happened.
            expect(await getJson(`/api/stats/${deviceId}`)).toEqual({});
            expect(await getJson(`/api/stats/${deviceId}?mode=custom`)).toEqual({});

            const classicGlobalAfter = await poll(async () => {
              const g = await getJson('/api/stats/global?ruleset=classic');
              return g.totalGamesPlayed === (globalClassicBefore.totalGamesPlayed ?? 0) + 1 ? g : null;
            });
            expect(classicGlobalAfter).not.toBeNull();
            expect(classicGlobalAfter.totalTuttos).toBe((globalClassicBefore.totalTuttos ?? 0) + 3);
            // The modernized global row did not move at all.
            const globalModernizedAfter = await getJson('/api/stats/global');
            expect(globalModernizedAfter.totalGamesPlayed).toBe(globalModernizedBefore.totalGamesPlayed);

            // Play Again with a CUSTOM classic config → classic_custom, and
            // only the classic row's customGamesPlayed moves.
            s1.emit('pushState', { roomId, newState: { status: 'playing', finished: false, winningScore: 1000 } });
            s1.emit('pushState', { roomId, newState: { status: 'playing', finished: true } });
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, wins: 0, totalScore: 111 } });
            s1.emit('submitGlobalStats', { roomId, payload: { gamesPlayed: 1, totalScore: 111, isDefaultGame: true } });

            const classicCustom = await poll(async () => {
              const body = await getJson(`/api/stats/${deviceId}?mode=classic_custom`);
              return body?.gamesPlayed >= 1 ? body : null;
            });
            expect(classicCustom).not.toBeNull();
            expect(classicCustom.totalScore).toBe(111);

            const classicGlobalFinal = await poll(async () => {
              const g = await getJson('/api/stats/global?ruleset=classic');
              return g.customGamesPlayed === (globalClassicBefore.customGamesPlayed ?? 0) + 1 ? g : null;
            });
            expect(classicGlobalFinal).not.toBeNull();
            // The custom classic game added no sums to either row.
            expect(classicGlobalFinal.totalScore).toBe(classicGlobalAfter.totalScore);

            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          } catch (e) {
            clearTimeout(timeoutId);
            s1.disconnect();
            reject(e);
          }
        });
      });
    });
  }, 15000);

  it('ignores a duplicate endGameStats/submitGlobalStats for the same game (e.g. a reconnect after finish), but accepts them again once a new game starts', () => {
    return new Promise((resolve, reject) => {
      const deviceId = 'dev-egs-dedup';
      const roomId = 'EGS_DEDUP_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 10000);

      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const pollDeviceScore = async (expected) => {
        for (let i = 0; i < 75; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body?.totalScore === expected) return body;
          await new Promise(r => setTimeout(r, 40));
        }
        throw new Error(`totalScore never reached ${expected}`);
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, async () => {
          try {
            // Game 1: start and finish (stats are only accepted for a
            // finished game), then record.
            s1.emit('pushState', {
              roomId,
              newState: {
                players: [{ name: 'Alice', deviceId, socketId: s1.id, disconnected: false, score: 0 }],
                status: 'playing', currentPlayerIndex: 0,
              },
            });
            s1.emit('pushState', { roomId, newState: { finished: true } });
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 100 } });
            await pollDeviceScore(100);

            // Duplicate for the SAME game (e.g. a reconnect re-triggering the
            // client's "finished just became true" path) — must be ignored. If it
            // were applied, totalScore would become 100 + 99999.
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 99999 } });
            await new Promise(r => setTimeout(r, testDelay(300)));
            const stillOne = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`).then(r => r.json());
            expect(stillOne.totalScore).toBe(100);
            expect(stillOne.gamesPlayed).toBe(1);

            // "Play Again" (finished→playing) — resets the per-game dedup —
            // then finish the second game too.
            s1.emit('pushState', {
              roomId,
              newState: { status: 'playing', finished: false, currentPlayerIndex: 0 },
            });
            s1.emit('pushState', { roomId, newState: { finished: true } });
            await new Promise(r => setTimeout(r, testDelay(200)));

            // Now a submission for the NEW game must be accepted.
            s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 50 } });
            await pollDeviceScore(150); // 100 (first game) + 50 (second game)

            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          } catch (e) {
            clearTimeout(timeoutId);
            s1.disconnect();
            reject(e);
          }
        });
      });
    });
  }, 12000);

  it('ignores a duplicate submitGlobalStats for the same game from the host', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'SGS_DEDUP_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 10000);

      // global_statistics is a single shared row across every test in this file,
      // so assert on the DELTA this test causes, not an absolute value.
      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const getGlobalTotalScore = async () => {
        const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/global`);
        const body = await res.json();
        return body.totalScore ?? 0;
      };
      const pollGlobalTotalScore = async (expected) => {
        for (let i = 0; i < 75; i++) {
          if ((await getGlobalTotalScore()) === expected) return;
          await new Promise(r => setTimeout(r, 40));
        }
        throw new Error(`global totalScore never reached ${expected}`);
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-sgs-dedup', color: '#ff0000' }, async () => {
          try {
            const before = await getGlobalTotalScore();

            // Stats are only accepted once the game has finished.
            s1.emit('pushState', { roomId, newState: { status: 'playing', finished: true } });
            s1.emit('submitGlobalStats', { roomId, payload: { totalScore: 100 } });
            await pollGlobalTotalScore(before + 100);

            // Duplicate for the same game — must be ignored, not added again.
            s1.emit('submitGlobalStats', { roomId, payload: { totalScore: 99999 } });
            await new Promise(r => setTimeout(r, testDelay(300)));
            expect(await getGlobalTotalScore()).toBe(before + 100);

            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          } catch (e) {
            clearTimeout(timeoutId);
            s1.disconnect();
            reject(e);
          }
        });
      });
    });
  }, 12000);

  it('endGameStats rejects a write for a device the socket does not own', () => {
    return new Promise((resolve, reject) => {
      const ownDevice = 'dev-egs-owner';
      const foreignDevice = 'dev-egs-foreign';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 6000);
      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'EGS_FOREIGN_ROOM', name: 'Alice', deviceId: ownDevice, color: '#ff0000' }, () => {
          // Stage a finished game so the ownership check below is the ONLY
          // thing rejecting the write (not the finished-game gate).
          s1.emit('pushState', { roomId: 'EGS_FOREIGN_ROOM', newState: { status: 'playing', finished: true } });
          // Attempt to write stats for a device this socket does not own — must be ignored.
          s1.emit('endGameStats', { deviceId: foreignDevice, stats: { gamesPlayed: 99, totalScore: 999999 } });

          // Give the server time to (not) process it, then confirm no row exists.
          setTimeout(async () => {
            try {
              const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${foreignDevice}`);
              const body = await res.json();
              expect(body.gamesPlayed === undefined || body.gamesPlayed === null).toBe(true);
              clearTimeout(timeoutId);
              s1.disconnect();
              resolve();
            } catch (e) {
              clearTimeout(timeoutId);
              s1.disconnect();
              reject(e);
            }
          }, 200);
        });
      });
    });
  }, 10000);

  it('Play Again (finished→playing without a lobby push) resets the stats dedup and adopts the host\'s new player order', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'PLAY_AGAIN_ROOM';
      const deviceId = 'dev-pa-a';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 10000);

      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const pollDeviceScore = async (expected) => {
        for (let i = 0; i < 75; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body?.totalScore === expected) return body;
          await new Promise(r => setTimeout(r, 40));
        }
        throw new Error(`totalScore never reached ${expected}`);
      };

      let latestState = null;
      s1.on('gameState', (state) => { latestState = state; });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-pa-b', color: '#00ff00' }, async () => {
            try {
              const players = [
                { name: 'Alice', deviceId, socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob', deviceId: 'dev-pa-b', socketId: s2.id, disconnected: false, score: 0 },
              ];

              // Game 1: normal lobby→playing start, then finish and record stats.
              s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });
              await new Promise(r => setTimeout(r, 80));
              s1.emit('pushState', { roomId, newState: { finished: true } });
              s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 100 } });
              await pollDeviceScore(100);

              // "Play Again" from the EndScreen: the room never returns to the
              // lobby — the host pushes playing+finished:false directly, with a
              // freshly shuffled order (Bob now first).
              s1.emit('pushState', {
                roomId,
                newState: {
                  players: [
                    { name: 'Bob', score: 0, disconnected: false },
                    { name: 'Alice', score: 0, disconnected: false },
                  ],
                  status: 'playing', finished: false, currentPlayerIndex: 0,
                },
              });
              await new Promise(r => setTimeout(r, 80));

              // The new shuffle must be adopted, not discarded.
              expect(latestState.players.map((p) => p.name)).toEqual(['Bob', 'Alice']);

              // Finish game 2 — stats are only accepted for a finished game —
              // then they must be accepted (dedup was reset by the restart).
              s1.emit('pushState', { roomId, newState: { finished: true } });
              s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 50 } });
              await pollDeviceScore(150); // 100 (game 1) + 50 (game 2)

              clearTimeout(timeoutId);
              cleanup();
              resolve(undefined);
            } catch (e) {
              clearTimeout(timeoutId);
              cleanup();
              reject(e);
            }
          });
        });
      });
    });
  }, 12000);
});
