/**
 * @vitest-environment node
 *
 * Socket integration suite — room lifecycle & joining.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { startTestServer, testDelay } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';

describe('Server Socket E2E — room lifecycle & joining', () => {
  let serverProcess;

  const PORT = TEST_PORTS.socketsRoom;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, 20000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('applies initialConfig when creating a new room', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);

      s1.on('connect', () => {
        const initialConfig = {
          winningScore: 7777,
          randomOrder: false,
          turnDuration: 90,
          reconnectTimeout: 30,
          initialCards: {
            Kleeblatt: 2, Feuerwerk: 2, Stop: 2, Kniffel: 2,
            Plus_Minus: 2, x2: 2, '200': 2, '300': 2, '400': 2, '500': 2, '600': 2,
          }
        };

        s1.emit('joinRoom', { roomId: 'CONFIG_TEST', name: 'Alice', deviceId: 'dev-config-apply', initialConfig }, (res: { success: boolean }) => {
          if (!res.success) {
            reject(new Error('joinRoom failed'));
          }
        });

        s1.on('gameState', (state: {
          winningScore: number;
          randomOrder: boolean;
          turnDuration: number;
          reconnectTimeout: number;
          initialCards: Record<string, number>;
        }) => {
          expect(state.winningScore).toBe(7777);
          expect(state.randomOrder).toBe(false);
          expect(state.turnDuration).toBe(90);
          expect(state.reconnectTimeout).toBe(30);
          expect(state.initialCards['200']).toBe(2);
          s1.disconnect();
          resolve();
        });
      });
      
      setTimeout(() => reject(new Error('Test timed out')), 2000);
    });
  });

  it('ignores invalid initialConfig values when creating a new room, keeping the defaults', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);

      s1.on('connect', () => {
        // Every field invalid: out of range, wrong type, or a deck that could
        // hang buildDeck. joinRoom must apply none of them (same validator as
        // updateConfig).
        const initialConfig = {
          winningScore: NaN,
          randomOrder: 'yes',
          turnDuration: -5,
          reconnectTimeout: 999999,
          initialCards: { '200': 1e9, Bogus: 3 },
        };

        s1.emit('joinRoom', { roomId: 'CONFIG_INVALID_TEST', name: 'Alice', deviceId: 'dev-config-invalid', initialConfig }, (res: { success: boolean }) => {
          if (!res.success) {
            reject(new Error('joinRoom failed'));
          }
        });

        s1.on('gameState', (state: {
          winningScore: number;
          randomOrder: boolean;
          turnDuration: number;
          reconnectTimeout: number;
          initialCards: Record<string, number>;
        }) => {
          expect(state.winningScore).toBe(6000);
          expect(state.randomOrder).toBe(true);
          expect(state.turnDuration).toBe(120);
          expect(state.reconnectTimeout).toBe(60);
          expect(state.initialCards).toEqual({
            Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5,
            Plus_Minus: 5, x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          });
          s1.disconnect();
          resolve();
        });
      });

      setTimeout(() => reject(new Error('Test timed out')), 2000);
    });
  });

  it('does not send gameState to a player who just left the room intentionally', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      let s2GameStateCount = 0;
      let s1ReceivedBobLeft = false;

      let timeoutId = setTimeout(() => {
        reject(new Error(`Test timed out.`));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Alice', deviceId: 'dev-e2eleave-alice', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Bob', deviceId: 'dev-bob2', color: '#00ff00' }, () => {
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-e2eleave-alice', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-bob2', socketId: s2.id, disconnected: false, score: 0 }
            ];
            s1.emit('pushState', {
              roomId: 'E2E_ROOM_LEAVE',
              newState: { players: mockPlayers, status: 'playing' }
            });
            
            setTimeout(() => {
              // Setup listener for Bob *before* he leaves, to catch any synchronous rogue broadcasts
              s2.on('gameState', () => {
                s2GameStateCount++;
              });
              
              // Bob intentionally leaves the room
              s2.emit('leaveRoom');
            }, testDelay(100));
          });
        });
      });

      s1.on('gameState', (state) => {
        // Once Alice receives the updated gameState showing Bob is gone, we wait 500ms and check s2.
        if (state.players && state.players.length === 1 && state.players[0].name === 'Alice') {
          if (s1ReceivedBobLeft) return;
          s1ReceivedBobLeft = true;
          setTimeout(() => {
            expect(s2GameStateCount).toBe(0); // Bob should have received 0 gameState updates after leaving
            clearTimeout(timeoutId);
            s1.disconnect();
            s2.disconnect();
            resolve();
          }, 500);
        }
      });
    });
  }, 10000);

  it('cleans up the old room when a socket joins a new room without explicitly leaving', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let s2: ReturnType<typeof io>;
      
      let s1ReceivedRoomA = false;
      let s2SawAliceLeave = false;
      
      let timeoutId = setTimeout(() => {
        if (s1) s1.disconnect();
        if (s2) s2.disconnect();
        reject(new Error(`Test timed out.`));
      }, 5000);

      s1.on('connect', () => {
        // First s1 joins Room A
        s1.emit('joinRoom', { roomId: 'GHOST_TEST_A', name: 'Alice', deviceId: 'dev-ghosttest-alice', color: '#ff0000' }, () => {

          // Then s2 connects and joins Room A
          s2 = io(`http://127.0.0.1:${PORT}`);
          s2.on('connect', () => {
            s2.emit('joinRoom', { roomId: 'GHOST_TEST_A', name: 'Bob', deviceId: 'dev-ghosttest-bob', color: '#00ff00' }, () => {

              // Now s1 joins Room B without calling leaveRoom
              s1.emit('joinRoom', { roomId: 'GHOST_TEST_B', name: 'Alice2', deviceId: 'dev-ghosttest-alice2', color: '#0000ff' }, () => {
                
                // Now start listening to s1 to ensure it doesn't get Room A updates anymore
                s1.on('gameState', (state) => {
                  if (state.players && state.players.some((p: { name: string }) => p.name === 'Bob')) {
                    s1ReceivedRoomA = true;
                  }
                });

                // Set up s2 listener
                s2.on('gameState', (state) => {
                  if (state.players && state.players.length === 1 && state.players[0].name === 'Bob') {
                    s2SawAliceLeave = true;
                  }
                });

                // Trigger a gameState update in Room A via Bob
                s2.emit('updatePlayerColor', { roomId: 'GHOST_TEST_A', color: '#123456' });

                setTimeout(() => {
                  expect(s1ReceivedRoomA).toBe(false); // s1 should not get room A updates
                  expect(s2SawAliceLeave).toBe(true); // s2 should have seen s1 leave
                  clearTimeout(timeoutId);
                  s1.disconnect();
                  s2.disconnect();
                  resolve();
                }, 500);
              });
            });
          });
        });
      });
    });
  }, 10000);

  it('deletes the old room when a socket was its sole member and then joins a different room', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let s2: ReturnType<typeof io>;

      const timeoutId = setTimeout(() => {
        if (s1) s1.disconnect();
        if (s2) s2.disconnect();
        reject(new Error('Test timed out.'));
      }, 5000);

      s1.on('connect', () => {
        // s1 creates and is the only member of SOLE_TEST_A
        s1.emit('joinRoom', { roomId: 'SOLE_TEST_A', name: 'Alice', deviceId: 'dev-sole-alice', color: '#ff0000' }, () => {
          // s1 immediately joins SOLE_TEST_B without leaving — as the sole member,
          // SOLE_TEST_A should be deleted (not left as an empty ghost room).
          s1.emit('joinRoom', { roomId: 'SOLE_TEST_B', name: 'Alice2', deviceId: 'dev-sole-alice2', color: '#0000ff' }, () => {

            // A fresh socket joining SOLE_TEST_A should get an empty new room
            // (one player — itself), confirming the old room was fully deleted.
            s2 = io(`http://127.0.0.1:${PORT}`);
            s2.on('connect', () => {
              s2.emit('joinRoom', { roomId: 'SOLE_TEST_A', name: 'Bob', deviceId: 'dev-sole-bob', color: '#00ff00' }, () => {
                s2.on('gameState', (state) => {
                  // If the room was truly deleted and recreated, only Bob is present.
                  // If the room had lingered with Alice still in it, there would be 2 players.
                  if (state.players && state.players.length === 1 && state.players[0].name === 'Bob') {
                    clearTimeout(timeoutId);
                    s1.disconnect();
                    s2.disconnect();
                    resolve();
                  } else if (state.players && state.players.length > 1) {
                    clearTimeout(timeoutId);
                    s1.disconnect();
                    s2.disconnect();
                    reject(new Error(`Room was not deleted: found ${state.players.length} players instead of 1`));
                  }
                });
              });
            });
          });
        });
      });
    });
  }, 10000);

  it('does not duplicate a player who calls joinRoom for the room they are already in (idempotent rejoin)', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out.'));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'IDEM_TEST', name: 'Alice', deviceId: 'dev-idem-alice', color: '#ff0000' }, () => {
          // Call joinRoom a second time with the same roomId — should be a no-op,
          // not add Alice as a second entry in the players list.
          s1.emit('joinRoom', { roomId: 'IDEM_TEST', name: 'Alice', deviceId: 'dev-idem-alice', color: '#ff0000' }, () => {
            s1.once('gameState', (state) => {
              const aliceCount = (state.players ?? []).filter((p: { name: string }) => p.name === 'Alice').length;
              expect(aliceCount).toBe(1);
              clearTimeout(timeoutId);
              s1.disconnect();
              resolve();
            });
          });
        });
      });
    });
  }, 10000);

  it('joinRoom returns an error (and does not crash) when name is missing', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 4000);

      s1.on('connect', () => {
        // No `name` field — previously crashed the handler at name.toLowerCase().
        s1.emit('joinRoom', { roomId: 'BAD_JOIN_NONAME', deviceId: 'dev-bj-1' }, (res) => {
          expect(res.error).toBeTruthy();
          expect(res.success).toBeFalsy();

          // Server must still be alive — a subsequent valid join must succeed.
          s1.emit('joinRoom', { roomId: 'BAD_JOIN_NONAME', name: 'Alice', deviceId: 'dev-bj-1', color: '#ff0000' }, (res2) => {
            expect(res2.success).toBe(true);
            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          });
        });
      });
    });
  }, 10000);

  it('joinRoom rejects an over-long name', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 4000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'BAD_JOIN_LONGNAME', name: 'x'.repeat(31), deviceId: 'dev-bj-2' }, (res) => {
          expect(res.error).toBeTruthy();
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        });
      });
    });
  }, 10000);

  it('joinRoom without an ack callback does not crash the server', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 4000);

      s1.on('connect', () => {
        // Emit with no ack callback — the handler must not throw on callback(...).
        s1.emit('joinRoom', { roomId: 'NO_CALLBACK_ROOM', name: 'Ghost', deviceId: 'dev-nc-1' });

        // If the server survived, a normal join (with callback) still works.
        setTimeout(() => {
          const s2 = io(`http://127.0.0.1:${PORT}`);
          s2.on('connect', () => {
            s2.emit('joinRoom', { roomId: 'NO_CALLBACK_ROOM2', name: 'Alice', deviceId: 'dev-nc-2', color: '#ff0000' }, (res) => {
              expect(res.success).toBe(true);
              clearTimeout(timeoutId);
              s1.disconnect();
              s2.disconnect();
              resolve();
            });
          });
        }, 200);
      });
    });
  }, 10000);

  it('attaches win streak from device statistics database to joining players', () => {
    return new Promise((resolve, reject) => {
      const deviceId = 'dev-streak-socket-test';
      const roomId = 'STREAK_SOCKET_ROOM';
      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

      // Seed a win streak of 5 by sending 5 consecutive wins
      const seedStats = async () => {
        for (let i = 0; i < 5; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-tutto-token': process.env.API_TOKEN || 'tutto-local-dev-token'
            },
            body: JSON.stringify({
              gamesPlayed: 1,
              wins: 1
            })
          });
          expect(res.status).toBe(200);
        }
      };

      seedStats().then(() => {
        const s1 = io(`http://127.0.0.1:${PORT}`);
        const cleanup = () => { s1.disconnect(); };
        const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Timed out')); }, 6000);

        s1.on('connect', () => {
          s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, (res2) => {
            expect(res2.success).toBe(true);
          });
        });

        s1.on('gameState', (state) => {
          try {
            const alice = state.players.find((p) => p.name === 'Alice');
            if (alice) {
              expect(alice.winStreak).toBe(5);
              clearTimeout(timeoutId);
              cleanup();
              resolve(undefined);
            }
          } catch (e) {
            clearTimeout(timeoutId);
            cleanup();
            reject(e);
          }
        });
      }).catch(reject);
    });
  });
});
