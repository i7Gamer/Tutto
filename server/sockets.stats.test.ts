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
import { DEFAULT_WINNING_SCORE } from '../src/utils/configValidation';
import { deviceStatsRequest } from '../src/utils/statsApi';
import { DEFAULT_GAME_MODE, type GameMode } from '../src/types';

describe('Server Socket E2E — statistics persistence', () => {
  let serverProcess;

  const PORT = TEST_PORTS.socketsStats;

  // setupTests replaces global.fetch with a mock that only matches relative
  // URLs; the real implementation is preserved on global.__nativeFetch.
  const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

  const getJson = async (path: string) => (await realFetch(`http://127.0.0.1:${PORT}${path}`)).json();

  // A device's statistics are not addressed by a path segment: the id rides
  // DEVICE_ID_HEADER instead, percent-encoded (see src/utils/statsApi.ts).
  // Built through the client's own deviceStatsRequest so these tests read
  // exactly what a real client reads — and keep doing so if that request's
  // shape changes again.
  const readDeviceStats = async (deviceId: string, mode: GameMode = DEFAULT_GAME_MODE) => {
    const [path, init] = deviceStatsRequest(deviceId, mode);
    return (await realFetch(`http://127.0.0.1:${PORT}${path}`, init)).json();
  };

  // ~3s of polling: generous for a local SQLite write to land, short enough
  // that a write which never happens fails here — with the device and the
  // expectation named — instead of at the test's own timeout.
  const STATS_POLL_ATTEMPTS = 75;
  const STATS_POLL_INTERVAL_MS = 40;

  /** Polls this device's bucket until `done` accepts the row; throws on giving up. */
  const pollDeviceStats = async (
    deviceId: string,
    mode: GameMode,
    done: (body) => boolean,
    what: string,
  ) => {
    for (let i = 0; i < STATS_POLL_ATTEMPTS; i++) {
      const body = await readDeviceStats(deviceId, mode);
      if (done(body)) return body;
      await new Promise(r => setTimeout(r, STATS_POLL_INTERVAL_MS));
    }
    throw new Error(`${deviceId} (${mode}) never ${what}`);
  };

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

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'EGS_SELF_ROOM', name: 'Alice', deviceId, color: '#ff0000' }, () => {
          // Stats are only accepted once the game has finished — stage a
          // started-and-finished game first (same-socket emits are ordered).
          s1.emit('pushState', { roomId: 'EGS_SELF_ROOM', newState: { status: 'playing', finished: true } });
          s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, wins: 1, totalScore: 1234 } });
          pollDeviceStats(deviceId, DEFAULT_GAME_MODE, b => b?.gamesPlayed >= 1, 'recorded a game').then((body) => {
            try {
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

            const custom = await pollDeviceStats(deviceId, 'custom', b => b?.gamesPlayed >= 1, 'recorded a game');
            expect(custom.totalScore).toBe(777);
            expect(custom.mode).toBe('custom');

            // The default read — what the lobby's win-streak lookup and every
            // old client sees — must not know this game happened.
            expect(await readDeviceStats(deviceId)).toEqual({});

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

            const classic = await pollDeviceStats(deviceId, 'classic', b => b?.gamesPlayed >= 1, 'recorded a game');
            expect(classic.totalScore).toBe(555);
            expect(classic.totalTuttos).toBe(3);
            expect(classic.mostCardsInTurn).toBe(2);
            expect(classic.mode).toBe('classic');

            // Neither modernized bucket knows this game happened.
            expect(await readDeviceStats(deviceId)).toEqual({});
            expect(await readDeviceStats(deviceId, 'custom')).toEqual({});

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

            const classicCustom = await pollDeviceStats(deviceId, 'classic_custom', b => b?.gamesPlayed >= 1, 'recorded a game');
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

      const pollDeviceScore = (expected: number) =>
        pollDeviceStats(deviceId, DEFAULT_GAME_MODE, b => b?.totalScore === expected, `reached totalScore ${expected}`);

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
            const stillOne = await readDeviceStats(deviceId);
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
      const getGlobalTotalScore = async () => (await getJson('/api/stats/global')).totalScore ?? 0;
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
              const body = await readDeviceStats(foreignDevice);
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

      const pollDeviceScore = (expected: number) =>
        pollDeviceStats(deviceId, DEFAULT_GAME_MODE, b => b?.totalScore === expected, `reached totalScore ${expected}`);

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

  it('keeps the stats dedup when the Play Again push is discarded for a stale roster', () => {
    // The dedup reset used to be decided before the push was applied, so a
    // "Play Again" the server threw away wholesale (its roster no longer
    // matches — see applyPushedState) still opened the door: the room was
    // still sitting on the SAME finished game, and its statistics could be
    // submitted a second time.
    return new Promise((resolve, reject) => {
      const roomId = 'STALE_RESTART_ROOM';
      const deviceId = 'dev-egs-stale';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 10000);

      const pollDeviceScore = (expected: number) =>
        pollDeviceStats(deviceId, DEFAULT_GAME_MODE, b => b?.totalScore === expected, `reached totalScore ${expected}`);

      let latestState = null;
      s1.on('gameState', (state) => { latestState = state; });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-egs-stale-b', color: '#00ff00' }, async () => {
            try {
              const players = [
                { name: 'Alice', deviceId, socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob', deviceId: 'dev-egs-stale-b', socketId: s2.id, disconnected: false, score: 0 },
              ];

              // Game 1: start, finish, record.
              s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });
              await new Promise(r => setTimeout(r, testDelay(400)));
              s1.emit('pushState', { roomId, newState: { finished: true } });
              s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 100 } });
              await pollDeviceScore(100);

              // "Play Again", composed against a roster that no longer exists
              // (Carol left between composing and sending) — the server
              // discards the WHOLE snapshot, so no second game ever starts.
              s1.emit('pushState', {
                roomId,
                newState: {
                  players: [...players, { name: 'Carol', score: 0, disconnected: false }],
                  status: 'playing', finished: false, currentPlayerIndex: 0,
                },
              });
              await new Promise(r => setTimeout(r, testDelay(400)));
              expect(latestState.finished, 'the discarded push must not have started a game').toBe(true);
              expect(latestState.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);

              // Still the same finished game, so its stats must still be
              // refused. A refusal is a non-event, so nothing about it can be
              // waited on directly — and a fixed sleep before reading the row
              // would let the test pass under load without the double count
              // ever having had time to appear. Both halves are therefore
              // paced by signals instead.
              s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 99999 } });

              // Signal one: the round trip. Same connection, so socket.io
              // preserves the order — once the restart below comes back as a
              // broadcast, the refused submission has already been through the
              // handler (which decides synchronously, before any await).
              const restarted = new Promise(r => { s1.once('gameState', r); });
              s1.emit('pushState', {
                roomId,
                newState: { players, status: 'playing', finished: false, currentPlayerIndex: 0 },
              });
              await restarted;
              expect((await readDeviceStats(deviceId)).totalScore).toBe(100);

              // Signal two, the decisive one: a legitimate second game, whose
              // write CAN be waited for. The device row is a single atomic
              // upsert per submission, so landing on exactly 100+50 proves the
              // refused submission contributed nothing — had the dedup
              // regressed, the row would be on its way to 100+99999+50 and
              // this poll could never see 150 at all.
              s1.emit('pushState', { roomId, newState: { finished: true } });
              s1.emit('endGameStats', { deviceId, stats: { gamesPlayed: 1, totalScore: 50 } });
              const after = await pollDeviceScore(150);
              expect(after.gamesPlayed).toBe(2);

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

  it('keeps the finished game\'s stats bucket when the Play Again push is discarded for a stale roster', () => {
    // Sibling of the dedup test above, same root cause: the "this push started
    // a game" bookkeeping ran even for a snapshot the server threw away
    // wholesale. normalizedGame is re-derived there, from the CURRENT config —
    // so a discarded restart could relabel the still-finished game. A custom
    // game whose winning score had since been pushed back to the default would
    // suddenly count as normalized, and every device that had not submitted
    // yet (a slower client, a reconnect) landed in the bucket whose totals and
    // records a custom game must never touch.
    const CUSTOM_WINNING_SCORE = 1000;
    return new Promise<void>((resolve, reject) => {
      const roomId = 'STALE_RESTART_BUCKET_ROOM';
      const aliceDevice = 'dev-bucket-a';
      const bobDevice = 'dev-bucket-b';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 16000);

      const pollCustomBucket = (deviceId: string) =>
        pollDeviceStats(deviceId, 'custom', b => b?.gamesPlayed >= 1, 'landed in the custom bucket');
      // pushState has no ack, but it always ends in a broadcast — so the next
      // gameState is the proof that THIS push has been processed, which the
      // steps below need before the next emit may depend on its effect.
      const nextGameState = (socket: typeof s1) =>
        new Promise<void>(r => { socket.once('gameState', () => r()); });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: aliceDevice, color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: bobDevice, color: '#00ff00' }, async () => {
            try {
              const players = [
                { name: 'Alice', deviceId: aliceDevice, socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob', deviceId: bobDevice, socketId: s2.id, disconnected: false, score: 0 },
              ];

              // Game 1 starts on a CUSTOM winning score → the custom bucket.
              let settled = nextGameState(s1);
              s1.emit('pushState', {
                roomId,
                newState: {
                  players, status: 'playing', currentPlayerIndex: 0,
                  winningScore: CUSTOM_WINNING_SCORE,
                },
              });
              await settled;

              // The default is pushed back mid-game. The label must NOT follow:
              // normalizedGame only ever downgrades, never upgrades.
              settled = nextGameState(s1);
              s1.emit('pushState', { roomId, newState: { winningScore: DEFAULT_WINNING_SCORE } });
              await settled;

              settled = nextGameState(s1);
              s1.emit('pushState', { roomId, newState: { finished: true } });
              await settled;

              // Alice submits while the game is still labelled correctly.
              s1.emit('endGameStats', { deviceId: aliceDevice, stats: { gamesPlayed: 1, totalScore: 100 } });
              await pollCustomBucket(aliceDevice);

              // "Play Again" composed against a roster that no longer exists —
              // discarded wholesale, so no second game ever starts.
              settled = nextGameState(s1);
              s1.emit('pushState', {
                roomId,
                newState: {
                  players: [...players, { name: 'Carol', score: 0, disconnected: false }],
                  status: 'playing', finished: false, currentPlayerIndex: 0,
                },
              });
              await settled;

              // Bob only gets his submission in now — still the same finished
              // custom game, so still the custom bucket.
              s2.emit('endGameStats', { deviceId: bobDevice, stats: { gamesPlayed: 1, totalScore: 50 } });
              const bobCustom = await pollCustomBucket(bobDevice);
              expect(bobCustom.totalScore).toBe(50);
              // The normalized bucket — the one the lobby's win-streak lookup
              // and the personal records read — must not know this game happened.
              expect(await readDeviceStats(bobDevice)).toEqual({});

              clearTimeout(timeoutId);
              cleanup();
              resolve();
            } catch (e) {
              clearTimeout(timeoutId);
              cleanup();
              reject(e);
            }
          });
        });
      });
    });
  }, 20000);
});
