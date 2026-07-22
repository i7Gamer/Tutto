/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

describe('Server Socket E2E Simulation', () => {
  let serverProcess;
  let socket1;
  let socket2;

  // We will run the server on port 3005 for testing
  const PORT = '3005';
  const SCALE = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
  const testDelay = (ms: number) => Math.max(20, Math.floor(ms * SCALE));

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      // FORCE_INIT_DB makes the child run migrations against its in-memory DB so the
      // endGameStats persistence tests can observe real writes (and verify scoping).
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe'
      });

      let stdout = '';
      let dbReady = false;
      let serverListening = false;
      const maybeResolve = () => { if (dbReady && serverListening) resolve(); };
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) { serverListening = true; maybeResolve(); }
        if (stdout.includes('Database migrated to the latest version')) { dbReady = true; maybeResolve(); }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error('Server stderr:', data.toString());
      });

      serverProcess.on('error', (err) => {
        reject(err);
      });
    });
  }, 20000);

  afterAll(() => {
    if (socket1) socket1.disconnect();
    if (socket2) socket2.disconnect();
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

  it('preserves socket metadata, detects disconnects, and kicks player correctly', () => {
    return new Promise((resolve, reject) => {
      socket1 = io(`http://127.0.0.1:${PORT}`);
      socket2 = io(`http://127.0.0.1:${PORT}`);

      socket1.on('connect_error', (err) => console.error('socket1 connect_error:', err));
      socket2.on('connect_error', (err) => console.error('socket2 connect_error:', err));

      let stateUpdates = 0;
      let bobDisconnectedNotified = false;

      let timeoutId = setTimeout(() => {
        reject(new Error(`Test timed out. stateUpdates=${stateUpdates}, bobDisconnectedNotified=${bobDisconnectedNotified}`));
      }, 9000);

      socket1.on('connect', () => {
        socket1.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Alice', deviceId: 'dev-e2e-alice', color: '#ff0000' }, (res) => {
          expect(res.success).toBe(true);

          socket2.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Bob', deviceId: 'dev-e2e-bob', color: '#00ff00' }, (res2) => {
            expect(res2.success).toBe(true);

            // Simulating Alice explicitly pushing state to start game
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-e2e-alice', socketId: socket1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-e2e-bob', socketId: socket2.id, disconnected: false, score: 0 }
            ];
            socket1.emit('pushState', {
              roomId: 'E2E_ROOM',
              newState: {
                players: mockPlayers,
                status: 'playing',
                currentPlayerIndex: 0,
                reconnectTimeout: 1 // Kick timer 1 second for fast testing
              }
            });
            
            // Wait a brief moment to ensure state was pushed before disconnecting
            setTimeout(() => {
              socket2.disconnect();
            }, 100);
          });
        });
      });

      socket1.on('playerDisconnected', (name) => {
        if (name === 'Bob') bobDisconnectedNotified = true;
      });

      socket1.on('gameState', (state) => {
        stateUpdates++;
        
        // Skip early states
        if (stateUpdates < 3) return;

        if (state.players.length === 1) {
          // Second check passed: player was kicked after timeout
          expect(state.players[0].name).toBe('Alice');
          expect(bobDisconnectedNotified).toBe(true);
          clearTimeout(timeoutId);
          resolve();
        }
      });
    });
  }, 10000);

  it('ignores pushState from a player who is neither host nor the active player', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host + active player
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — neither

      let bobPushObserved = false;
      const timeoutId = setTimeout(() => {
        // No 'hacked' state ever propagated → the malicious push was rejected.
        expect(bobPushObserved).toBe(false);
        s1.disconnect();
        s2.disconnect();
        resolve();
      }, 1500);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_AUTH', name: 'Alice', deviceId: 'dev-a3', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_AUTH', name: 'Bob', deviceId: 'dev-b3', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-a3', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-b3', socketId: s2.id, disconnected: false, score: 0 }
            ];
            // Alice (host) legitimately starts the game; it's Alice's turn (index 0).
            s1.emit('pushState', { roomId: 'E2E_AUTH', newState: { players, status: 'playing', currentPlayerIndex: 0 } });

            setTimeout(() => {
              // Bob is not host and not the active player → this must be ignored.
              s2.emit('pushState', { roomId: 'E2E_AUTH', newState: { players: [], status: 'hacked', currentPlayerIndex: 0 } });
            }, 200);
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'hacked' || (state.players && state.players.length === 0)) {
          bobPushObserved = true;
          clearTimeout(timeoutId);
          reject(new Error('Server accepted pushState from an unauthorized player'));
        }
      });
    });
  }, 10000);

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
            }, 100);
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

  it('rejects invalid color strings in updatePlayerColor', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let timeoutId = setTimeout(() => {
        s1.disconnect();
        resolve(); // If no invalid color was broadcasted, we pass
      }, 300);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'COLOR_ROOM', name: 'Alice', deviceId: 'dev-color-alice', color: '#ff0000' }, () => {
          s1.emit('updatePlayerColor', { roomId: 'COLOR_ROOM', color: 'invalid-color' });
        });
      });

      s1.on('gameState', (state) => {
        if (state.players && state.players[0] && state.players[0].color === 'invalid-color') {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server accepted invalid color string'));
        }
      });
    });
  });

  it('ignores updateConfig with out-of-bounds values', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let timeoutId = setTimeout(() => {
        s1.disconnect();
        resolve(); // If no invalid config was broadcasted, we pass
      }, 300);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CONFIG_ROOM', name: 'Alice', deviceId: 'dev-configbounds-alice', color: '#ff0000' }, () => {
          s1.emit('updateConfig', { winningScore: -100, turnDuration: 9999, reconnectTimeout: -5 });
        });
      });

      s1.on('gameState', (state) => {
        if (state.winningScore === -100 || state.turnDuration === 9999 || state.reconnectTimeout === -5) {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server accepted out-of-bounds config'));
        }
      });
    });
  });

  it('rejects pushState of host-only fields (status, winningScore) from a non-host active player', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player, not host

      let badStateObserved = false;
      const timeoutId = setTimeout(() => {
        expect(badStateObserved).toBe(false);
        s1.disconnect();
        s2.disconnect();
        resolve();
      }, 350);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_HOSTFIELDS', name: 'Alice', deviceId: 'dev-hf-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_HOSTFIELDS', name: 'Bob', deviceId: 'dev-hf-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-hf-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-hf-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            // Host starts the game with Bob as the active player (index 1).
            s1.emit('pushState', { roomId: 'E2E_HOSTFIELDS', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

            setTimeout(() => {
              // Bob is the active player but NOT the host.
              // Use sentinel values that could never arise from normal game flow.
              s2.emit('pushState', { roomId: 'E2E_HOSTFIELDS', newState: { status: 'hacked', winningScore: 1 } });
            }, 200);
          });
        });
      });

      s1.on('gameState', (state) => {
        // 'hacked' and winningScore===1 are sentinel values that only appear if the
        // server accepted the malicious push — they cannot arise from normal game flow.
        if (state.status === 'hacked' || state.winningScore === 1) {
          badStateObserved = true;
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          reject(new Error('Server accepted host-only fields from a non-host active player'));
        }
      });
    });
  }, 10000);

  it('adopts the host-chosen player order when the game starts (online random shuffle)', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_STARTORDER', name: 'Alice', deviceId: 'dev-so-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_STARTORDER', name: 'Bob', deviceId: 'dev-so-b', color: '#00ff00' }, () => {
            // Players joined as [Alice, Bob]. The host starts the game with a shuffled
            // order [Bob, Alice] and chart arrays built in that same order.
            const shuffled = [
              { name: 'Bob', deviceId: 'dev-so-b', socketId: s2.id, disconnected: false, score: 0 },
              { name: 'Alice', deviceId: 'dev-so-a', socketId: s1.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', {
              roomId: 'E2E_STARTORDER',
              newState: {
                players: shuffled,
                status: 'playing',
                currentPlayerIndex: 0,
                chartNames: ['Bob', 'Alice'],
                chartValues: [[], []],
                chartLabels: [],
              },
            });
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'playing' && state.players && state.players.length === 2) {
          // Server must adopt the host's order so the turn order and the chart arrays
          // agree: Bob first, Alice second — not the original join order.
          expect(state.players[0].name).toBe('Bob');
          expect(state.players[0].socketId).toBe(s2.id);
          expect(state.players[1].name).toBe('Alice');
          expect(state.players[1].socketId).toBe(s1.id);
          // deviceId is a reconnect credential and must never be broadcast.
          expect('deviceId' in state.players[0]).toBe(false);
          expect('deviceId' in state.players[1]).toBe(false);
          // Identities/colors are kept from the server side, in the new order.
          expect(state.players[0].color).toBe('#00ff00');
          expect(state.players[1].color).toBe('#ff0000');
          expect(state.chartNames).toEqual(['Bob', 'Alice']);
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('reorderPlayers preserves server-side player objects, ignoring injected client fields', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 3000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_REORDER_INJECT', name: 'Alice', deviceId: 'dev-ri-a', color: '#ff0000' }, () => {
          // Alice tries to reorder with an injected score field.
          const tampered = [{ name: 'Alice', score: 99999, deviceId: 'FAKE' }];
          s1.emit('reorderPlayers', { roomId: 'E2E_REORDER_INJECT', newPlayers: tampered });
        });
      });

      s1.on('gameState', (state) => {
        if (state.players && state.players.length === 1) {
          // The server must have kept the real score (0), not the injected value —
          // and deviceId (a reconnect credential) must never be broadcast at all.
          expect(state.players[0].score).toBe(0);
          expect('deviceId' in state.players[0]).toBe(false);
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('rejects reorderPlayers if new order has different length', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let timeoutId = setTimeout(() => {
        s1.disconnect();
        resolve(); // passed
      }, 300);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_ROOM', name: 'Alice', deviceId: 'dev-reorder-alice', color: '#ff0000' }, () => {
          s1.emit('reorderPlayers', []); // Send empty array when there's 1 player
        });
      });

      s1.on('gameState', (state) => {
        if (state.players && state.players.length === 0) {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server accepted invalid reorderPlayers'));
        }
      });
    });
  });

  it('accepts turnDuration=0 and reconnectTimeout=0 to disable timers', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out — server never broadcast updated config'));
      }, 3000);

      let joinedRoom = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'TIMER_OFF_ROOM', name: 'Alice', deviceId: 'dev-timer-off', color: '#ff0000' }, () => {
          joinedRoom = true;
          // Set timers to a valid value first, then disable them
          s1.emit('updateConfig', { roomId: 'TIMER_OFF_ROOM', turnDuration: 30, reconnectTimeout: 30 });
          setTimeout(() => {
            s1.emit('updateConfig', { roomId: 'TIMER_OFF_ROOM', turnDuration: 0, reconnectTimeout: 0 });
          }, 200);
        });
      });

      s1.on('gameState', (state) => {
        if (joinedRoom && state.turnDuration === 0 && state.reconnectTimeout === 0) {
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('shrinks chartValues and chartNames when a player is kicked', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — will be kicked

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CHART_KICK_ROOM', name: 'Alice', deviceId: 'dev-ck-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'CHART_KICK_ROOM', name: 'Bob', deviceId: 'dev-ck-b', color: '#00ff00' }, () => {
            // Host pushes initial state with chartValues for 2 players
            s1.emit('pushState', {
              roomId: 'CHART_KICK_ROOM',
              newState: {
                players: [
                  { name: 'Alice', deviceId: 'dev-ck-a', socketId: s1.id, disconnected: false, score: 100 },
                  { name: 'Bob', deviceId: 'dev-ck-b', socketId: s2.id, disconnected: false, score: 200 },
                ],
                status: 'playing',
                currentPlayerIndex: 0,
                chartValues: [[0, 100], [0, 200]],
                chartNames: ['Alice', 'Bob'],
                chartLabels: [1, 2],
              }
            });

            // Kick Bob after a short delay
            setTimeout(() => {
              s1.emit('kickPlayer', s2.id);
            }, 300);
          });
        });
      });

      s1.on('gameState', (state) => {
        // After the kick, players should be 1 and chartValues/chartNames should also be length 1
        // Guard: only check once chartLabels has been pushed (game started) and a player was removed
        if (state.players && state.players.length === 1 &&
            Array.isArray(state.chartValues) && state.chartValues.length > 0 &&
            Array.isArray(state.chartLabels) && state.chartLabels.length > 0) {
          expect(state.chartValues.length).toBe(1);
          expect(state.chartNames.length).toBe(1);
          expect(state.chartValues[0]).toEqual([0, 100]); // Alice's values preserved
          expect(state.chartNames[0]).toBe('Alice');
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('draws a valid card from a freshly built deck when the active player is kicked with an exhausted deck', () => {
    // handleActivePlayerRemoved's drawNextCardForRoom used to build the
    // replacement deck with a plain Fisher-Yates shuffle (buildShuffledDeck),
    // diverging from the shared buildDeck() used everywhere else turn
    // advancement happens. Now it reuses buildDeck() directly — with a single
    // card type in initialCards, the redrawn card is fully deterministic,
    // which lets us verify both that a valid card comes back and that
    // buildShuffledDeck (now removed) isn't secretly still in play.
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player, will be kicked
      const s3 = io(`http://127.0.0.1:${PORT}`); // Carol — needed so the room doesn't drop below 2 players and abort

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        s3.disconnect();
        reject(new Error('Test timed out'));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'DECK_EXHAUST_KICK_ROOM', name: 'Alice', deviceId: 'dev-dek-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'DECK_EXHAUST_KICK_ROOM', name: 'Bob', deviceId: 'dev-dek-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId: 'DECK_EXHAUST_KICK_ROOM', name: 'Carol', deviceId: 'dev-dek-c', color: '#0000ff' }, () => {
              s1.emit('pushState', {
                roomId: 'DECK_EXHAUST_KICK_ROOM',
                newState: {
                  players: [
                    { name: 'Alice', deviceId: 'dev-dek-a', socketId: s1.id, disconnected: false, score: 0 },
                    { name: 'Bob', deviceId: 'dev-dek-b', socketId: s2.id, disconnected: false, score: 0 },
                    { name: 'Carol', deviceId: 'dev-dek-c', socketId: s3.id, disconnected: false, score: 0 },
                  ],
                  status: 'playing',
                  currentPlayerIndex: 1,
                  currentCard: '200',
                  cards: [], // deck already exhausted
                  initialCards: { '200': 1 }, // single card type → fully deterministic redraw
                },
              });

              setTimeout(() => {
                s1.emit('kickPlayer', s2.id);
              }, 300);
            });
          });
        });
      });

      s1.on('gameState', (state) => {
        // Guard on both players.length===2 AND currentCard==='200' — joinRoom
        // itself broadcasts gameState after each join, so players.length briefly
        // equals 2 while Carol is still joining (with currentCard still null,
        // before pushState ever runs). Requiring currentCard==='200' too ensures
        // we only match the post-kick state, not that transient join broadcast.
        if (state.players && state.players.length === 2 && state.currentCard === '200') {
          expect(state.cards).toEqual([]);
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          s3.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('reorderPlayers is blocked when the game is already playing', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob

      const timeoutId = setTimeout(() => {
        // If no state change was received with reordered players after game start, the test passes
        s1.disconnect();
        s2.disconnect();
        resolve();
      }, 400);

      let originalOrder = null;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_MIDGAME', name: 'Alice', deviceId: 'dev-rmg-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'REORDER_MIDGAME', name: 'Bob', deviceId: 'dev-rmg-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-rmg-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-rmg-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            // Host starts the game
            s1.emit('pushState', { roomId: 'REORDER_MIDGAME', newState: { players, status: 'playing', currentPlayerIndex: 0 } });

            setTimeout(() => {
              originalOrder = ['Alice', 'Bob'];
              // Attempt to reorder mid-game (Bob first)
              s1.emit('reorderPlayers', {
                roomId: 'REORDER_MIDGAME',
                newPlayers: [{ name: 'Bob' }, { name: 'Alice' }]
              });
            }, 300);
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'playing' && originalOrder && state.players?.length === 2) {
          // If the server accepted the reorder, Bob would now be first — that must not happen
          if (state.players[0].name === 'Bob') {
            clearTimeout(timeoutId);
            s1.disconnect();
            s2.disconnect();
            reject(new Error('Server allowed reorderPlayers during a live game'));
          }
        }
      });
    });
  }, 10000);

  it('updateConfig is blocked when the game is already playing', () => {
    // Same rule reorderPlayers already enforces (test above): config is a
    // lobby-only concept. Without this, a client could flip the win condition
    // (winningScore) or rebuild the deck (initialCards) out from under an
    // in-progress game.
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host

      const timeoutId = setTimeout(() => {
        // If no state change was received with the tampered winningScore
        // after game start, the test passes.
        s1.disconnect();
        resolve();
      }, 400);

      let gameStarted = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'UPDATECONFIG_MIDGAME', name: 'Alice', deviceId: 'dev-ucmg-a', color: '#ff0000' }, () => {
          const players = [
            { name: 'Alice', deviceId: 'dev-ucmg-a', socketId: s1.id, disconnected: false, score: 0 },
          ];
          s1.emit('pushState', { roomId: 'UPDATECONFIG_MIDGAME', newState: { players, status: 'playing', currentPlayerIndex: 0, winningScore: 6000 } });

          setTimeout(() => {
            gameStarted = true;
            s1.emit('updateConfig', { roomId: 'UPDATECONFIG_MIDGAME', winningScore: 1000 });
          }, 300);
        });
      });

      s1.on('gameState', (state) => {
        if (gameStarted && state.status === 'playing' && state.winningScore === 1000) {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server allowed updateConfig during a live game'));
        }
      });
    });
  }, 10000);

  it('non-host active player can deduct Plus_Minus score from the host-leader', () => {
    // Regression test: the server previously rejected changes to other players' rows
    // pushed by a non-host, silently discarding the Plus_Minus -1000 deduction from
    // the leader (host). The per-row restriction has been removed — see server/index.js.
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host, current leader at 1000 pts
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — non-host, active player, plays Plus_Minus

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 4000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'PM_DEDUCT_ROOM', name: 'Alice', deviceId: 'dev-pm-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'PM_DEDUCT_ROOM', name: 'Bob', deviceId: 'dev-pm-b', color: '#00ff00' }, () => {
            // Alice leads at 1000; Bob is the active player (index 1, Plus_Minus turn)
            const players = [
              { name: 'Alice', deviceId: 'dev-pm-a', socketId: s1.id, disconnected: false, score: 1000 },
              { name: 'Bob',   deviceId: 'dev-pm-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', { roomId: 'PM_DEDUCT_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

            setTimeout(() => {
              // Bob completes Plus_Minus: Alice deducted 1000→0, Bob gains 0→1000
              s2.emit('pushState', {
                roomId: 'PM_DEDUCT_ROOM',
                newState: {
                  players: [
                    { name: 'Alice', deviceId: 'dev-pm-a', socketId: s1.id, disconnected: false, score: 0,    times1000PointsDeducted: 1 },
                    { name: 'Bob',   deviceId: 'dev-pm-b', socketId: s2.id, disconnected: false, score: 1000, timesPlusMinusCompleted: 1 },
                  ],
                  currentPlayerIndex: 0,
                  previousCard: 'Plus_Minus',
                  previousScore: 1000,
                  previousLeaders: [{ name: 'Alice', score: 1000 }],
                }
              });
            }, 300);
          });
        });
      });

      let gameStarted = false;
      s1.on('gameState', (state) => {
        if (state.status === 'playing' && state.players?.length === 2) gameStarted = true;
        if (!gameStarted) return;
        const alice = state.players?.find(p => p.name === 'Alice');
        const bob   = state.players?.find(p => p.name === 'Bob');
        // Deduction accepted: Alice at 0, Bob at 1000
        if (alice && bob && alice.score === 0 && bob.score === 1000) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('non-host active player undo can restore the previous (host) player score', () => {
    // Regression test for undo: when a non-host is the current active player and
    // undoes the previous (host) player's score, the server previously rejected the
    // host's row change because of the per-row restriction. Now it must be accepted.
    // Scenario: Alice (host) scored 500, now it's Bob's turn (index 1).
    // Bob clicks undo → Alice's score is reversed from 500 to 0.
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — non-host, current active player

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 4000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'UNDO_HOST_SCORE', name: 'Alice', deviceId: 'dev-uh-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'UNDO_HOST_SCORE', name: 'Bob', deviceId: 'dev-uh-b', color: '#00ff00' }, () => {
            // Alice scored 500 on her turn; now it's Bob's turn (index 1)
            const players = [
              { name: 'Alice', deviceId: 'dev-uh-a', socketId: s1.id, disconnected: false, score: 500 },
              { name: 'Bob',   deviceId: 'dev-uh-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', {
              roomId: 'UNDO_HOST_SCORE',
              newState: { players, status: 'playing', currentPlayerIndex: 1, previousCard: '200', previousScore: 500 }
            });

            setTimeout(() => {
              // Bob (non-host, active player) pushes undo: Alice's 500 reversed, back to Alice's turn
              s2.emit('pushState', {
                roomId: 'UNDO_HOST_SCORE',
                newState: {
                  players: [
                    { name: 'Alice', deviceId: 'dev-uh-a', socketId: s1.id, disconnected: false, score: 0 },
                    { name: 'Bob',   deviceId: 'dev-uh-b', socketId: s2.id, disconnected: false, score: 0 },
                  ],
                  currentPlayerIndex: 0,
                  previousCard: null,
                }
              });
            }, 300);
          });
        });
      });

      let gameStarted = false;
      s1.on('gameState', (state) => {
        if (state.status === 'playing' && state.players?.length === 2) gameStarted = true;
        if (!gameStarted) return;
        const alice = state.players?.find(p => p.name === 'Alice');
        const bob   = state.players?.find(p => p.name === 'Bob');
        // Undo accepted: Alice's score reversed to 0
        if (alice && bob && alice.score === 0 && bob.score === 0 && state.previousCard === null) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('active player can push liveTurnState and it is forwarded to other players', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Timed out waiting for liveTurnState to be forwarded'));
      }, 8000);

      let gameStarted = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'LIVE_TURN_ROOM', name: 'Alice', deviceId: 'dev-lt-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'LIVE_TURN_ROOM', name: 'Bob', deviceId: 'dev-lt-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-lt-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob',   deviceId: 'dev-lt-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            // Alice (host) starts game with Bob as active player (index 1)
            s1.emit('pushState', { roomId: 'LIVE_TURN_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

            setTimeout(() => {
              // Bob pushes a live turn state snapshot
              s2.emit('pushState', {
                roomId: 'LIVE_TURN_ROOM',
                newState: {
                  liveTurnState: {
                    turnScore: 350, keptDice: [{ id: 'die-1', val: 1 }], currentRoll: [{ id: 'die-2', val: 5, selected: false }],
                    kniffelProgress: [], tuttosThisTurn: 0,
                  },
                },
              });
            }, 200);
          });
        });
      });

      // Alice observes the forwarded liveTurnState
      s1.on('gameState', (state) => {
        if (!gameStarted && state.status === 'playing') {
          gameStarted = true;
          return;
        }
        if (gameStarted && state.liveTurnState && state.liveTurnState.turnScore === 350) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('active player can push liveTurnState via the dedicated event and it is forwarded without a full gameState broadcast', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Timed out waiting for liveTurnState event'));
      }, 8000);

      let gameStarted = false;
      let sawFullGameStateAfterStart = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'LIVE_TURN_EVENT_ROOM', name: 'Alice', deviceId: 'dev-lte-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'LIVE_TURN_EVENT_ROOM', name: 'Bob', deviceId: 'dev-lte-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-lte-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob',   deviceId: 'dev-lte-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', { roomId: 'LIVE_TURN_EVENT_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

            setTimeout(() => {
              // Bob pushes a live turn state snapshot via the new dedicated event,
              // not 'pushState'.
              s2.emit('liveTurnState', {
                roomId: 'LIVE_TURN_EVENT_ROOM',
                liveTurnState: {
                  turnScore: 425, keptDice: [{ id: 'die-1', val: 1 }], currentRoll: [{ id: 'die-2', val: 5, selected: false }],
                  kniffelProgress: [], tuttosThisTurn: 0,
                },
              });
            }, 200);
          });
        });
      });

      // A full gameState broadcast after the game started would mean the new
      // event still triggers the old full-snapshot path — it must not.
      s1.on('gameState', (state) => {
        if (!gameStarted && state.status === 'playing') {
          gameStarted = true;
          return;
        }
        if (gameStarted) sawFullGameStateAfterStart = true;
      });

      s1.on('liveTurnState', (payload) => {
        if (payload?.liveTurnState?.turnScore === 425) {
          clearTimeout(timeoutId);
          expect(sawFullGameStateAfterStart).toBe(false);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('ignores a liveTurnState push from a socket that is neither host nor the active player', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player
      const s3 = io(`http://127.0.0.1:${PORT}`); // Carol — bystander, neither host nor active

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        s3.disconnect();
        resolve(); // no liveTurnState event ever arriving is the expected (passing) outcome
      }, 400);

      let gameStarted = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'LIVE_TURN_UNAUTH_ROOM', name: 'Alice', deviceId: 'dev-ltu-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'LIVE_TURN_UNAUTH_ROOM', name: 'Bob', deviceId: 'dev-ltu-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId: 'LIVE_TURN_UNAUTH_ROOM', name: 'Carol', deviceId: 'dev-ltu-c', color: '#0000ff' }, () => {
              const players = [
                { name: 'Alice', deviceId: 'dev-ltu-a', socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob',   deviceId: 'dev-ltu-b', socketId: s2.id, disconnected: false, score: 0 },
                { name: 'Carol', deviceId: 'dev-ltu-c', socketId: s3.id, disconnected: false, score: 0 },
              ];
              s1.emit('pushState', { roomId: 'LIVE_TURN_UNAUTH_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

              setTimeout(() => {
                s3.emit('liveTurnState', {
                  roomId: 'LIVE_TURN_UNAUTH_ROOM',
                  liveTurnState: {
                    turnScore: 999, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
                  },
                });
              }, 200);
            });
          });
        });
      });

      s1.on('gameState', (state) => {
        if (!gameStarted && state.status === 'playing') gameStarted = true;
      });

      s1.on('liveTurnState', (payload) => {
        if (payload?.liveTurnState?.turnScore === 999) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          s3.disconnect();
          reject(new Error('Bystander was able to push liveTurnState'));
        }
      });
    });
  }, 10000);

  it('closes room when host leaves and all remaining players are disconnected', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'HOST_LEAVE_ALL_DISC';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — disconnects unexpectedly
      let s3 = null;

      const cleanup = () => { s1.disconnect(); if (s3) s3.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 8000);

      let handled = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-hld-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-hld-b', color: '#00ff00' }, () => {
            s2.disconnect(); // unexpected disconnect — server marks Bob as disconnected
          });
        });
      });

      s1.on('gameState', (state) => {
        if (handled) return;
        const bob = state.players.find(p => p.name === 'Bob');
        if (bob && bob.disconnected) {
          handled = true;
          // Emit leaveRoom but do NOT disconnect s1 immediately — the transport must
          // stay open long enough for the server to receive and process the event.
          s1.emit('leaveRoom');

          // Wait for the server to process leaveRoom and delete the room, then verify
          // the same roomId is now a fresh slate (no Bob).
          setTimeout(() => {
            s3 = io(`http://127.0.0.1:${PORT}`);
            s3.emit('joinRoom', { roomId, name: 'Charlie', deviceId: 'dev-hld-c', color: '#0000ff' }, () => {});

            s3.on('gameState', (freshState) => {
              expect(freshState.players.some(p => p.name === 'Bob')).toBe(false);
              expect(freshState.players.some(p => p.name === 'Charlie')).toBe(true);
              clearTimeout(timeoutId);
              cleanup();
              resolve();
            });
          }, 500);
        }
      });
    });
  }, 10000);

  it('emits gameAborted when a player explicitly leaves during a game and only 1 player remains', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 5000);

      let abortReceived = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'ABORT_LEAVE_ROOM', name: 'Alice', deviceId: 'dev-al-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'ABORT_LEAVE_ROOM', name: 'Bob', deviceId: 'dev-al-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-al-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-al-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', { roomId: 'ABORT_LEAVE_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 0 } });
            setTimeout(() => s2.emit('leaveRoom'), 200);
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          expect(state.currentPlayerIndex).toBeNull();
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('emits gameAborted when a disconnected player times out and only 1 player remains', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 9000);

      let abortReceived = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'ABORT_TIMEOUT_ROOM', name: 'Alice', deviceId: 'dev-at-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'ABORT_TIMEOUT_ROOM', name: 'Bob', deviceId: 'dev-at-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-at-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-at-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', {
              roomId: 'ABORT_TIMEOUT_ROOM',
              newState: { players, status: 'playing', currentPlayerIndex: 0, reconnectTimeout: 1 },
            });
            setTimeout(() => s2.disconnect(), 200);
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('emits gameAborted when host kicks a player during a game and only 1 player remains', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 5000);

      let abortReceived = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'ABORT_KICK_ROOM', name: 'Alice', deviceId: 'dev-ak-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'ABORT_KICK_ROOM', name: 'Bob', deviceId: 'dev-ak-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-ak-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-ak-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', { roomId: 'ABORT_KICK_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 0 } });
            setTimeout(() => s1.emit('kickPlayer', s2.id), 200);
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('gameTimeInSeconds is server-calculated and increases monotonically across pushState calls', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'GAME_TIME_MONOTONIC';
      const s1 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let gameStarted = false;
      let firstGameTime = null;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-gtm-a', color: '#ff0000' }, () => {
          s1.emit('pushState', {
            roomId,
            newState: {
              status: 'playing',
              currentCard: '200',
              cards: [],
              currentPlayerIndex: 0,
              round: 1,
              finished: false,
              gameTimeInSeconds: 999, // Client sends stale/wrong value — server must override
              players: [{ name: 'Alice', deviceId: 'dev-gtm-a', score: 0 }],
            }
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status !== 'playing') return;

        if (!gameStarted) {
          gameStarted = true;
          firstGameTime = state.gameTimeInSeconds;

          // Server should override 999 with its own calculation (~0)
          expect(firstGameTime).toBeLessThan(5);

          setTimeout(() => {
            s1.emit('pushState', {
              roomId,
              newState: {
                status: 'playing',
                currentCard: '300',
                cards: [],
                currentPlayerIndex: 0,
                round: 1,
                finished: false,
                gameTimeInSeconds: 999, // Still stale — server must still override
                players: [{ name: 'Alice', deviceId: 'dev-gtm-a', score: 0 }],
              }
            });
          }, 200);
        } else {
          // Second update: still server-calculated (not 999)
          expect(state.gameTimeInSeconds).toBeLessThan(5);
          // Monotonically non-decreasing
          expect(state.gameTimeInSeconds).toBeGreaterThanOrEqual(firstGameTime);

          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

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
          }, 100);
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

  it('gameTimeInSeconds on game-end is the server-calculated elapsed time, not the stale client-pushed value', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'GAME_TIME_END_SNAPSHOT';
      const s1 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let seenPlaying = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-gtes-a', color: '#ff0000' }, () => {
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
              players: [{ name: 'Alice', deviceId: 'dev-gtes-a', score: 0 }],
            }
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'playing' && !seenPlaying) {
          seenPlaying = true;

          // Wait >1s so the server's authoritative elapsed time is at least 1
          setTimeout(() => {
            s1.emit('pushState', {
              roomId,
              newState: {
                status: 'playing',
                currentCard: '200',
                cards: [],
                currentPlayerIndex: 0,
                round: 1,
                finished: true,   // Game ends
                gameTimeInSeconds: 999, // Stale client value — server must snapshot the real time
                players: [{ name: 'Alice', deviceId: 'dev-gtes-a', score: 100 }],
              }
            });
          }, 1200);
        } else if (state.finished && seenPlaying) {
          // Server must have snapshotted the real elapsed time (~1-2s), not the stale 999
          expect(state.gameTimeInSeconds).toBeGreaterThanOrEqual(1);
          expect(state.gameTimeInSeconds).toBeLessThan(5);

          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('gameTimeInSeconds continues from correct server time on reconnect', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'GAME_TIME_RECONNECT';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Host / active player
      const s2 = io(`http://127.0.0.1:${PORT}`); // Observer (reconnects)

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 10000);

      let s2GameTimeAtDisconnect = null;
      let s2Connected = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-gtr2-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-gtr2-b', color: '#00ff00' }, () => {
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
                players: [
                  { name: 'Alice', deviceId: 'dev-gtr2-a', score: 0 },
                  { name: 'Bob', deviceId: 'dev-gtr2-b', score: 0 },
                ],
              }
            });
          });
        });
      });

      s2.on('gameState', (state) => {
        if (state.status !== 'playing' || s2Connected) return;
        s2Connected = true;

        // Wait so server game time advances a bit, then disconnect
        setTimeout(() => {
          s2GameTimeAtDisconnect = state.gameTimeInSeconds;
          s2.disconnect();

          setTimeout(() => {
            const s2New = io(`http://127.0.0.1:${PORT}`);
            s2New.on('connect', () => {
              s2New.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-gtr2-b', color: '#00ff00' }, () => {});
            });

            s2New.on('gameState', (newState) => {
              if (newState.status !== 'playing') return;
              // Server-calculated time should be >= what it was at disconnect
              expect(newState.gameTimeInSeconds).toBeGreaterThanOrEqual(s2GameTimeAtDisconnect);
              // Should not be the stale client value (e.g. 0 from initial push or 999)
              expect(newState.gameTimeInSeconds).toBeLessThan(10);

              clearTimeout(timeoutId);
              s1.disconnect();
              s2New.disconnect();
              resolve();
            });
          }, 300);
        }, 200);
      });
    });
  }, 10000);

  it('gameActualStartTime is preserved across turn/card changes (not reset on subsequent pushState)', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'GAME_TIME_PERSIST';
      const s1 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let firstGameTime = null;
      let seenFirstState = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-gtp-a', color: '#ff0000' }, () => {
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
              players: [{ name: 'Alice', deviceId: 'dev-gtp-a', score: 0 }],
            }
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status !== 'playing') return;

        if (!seenFirstState) {
          seenFirstState = true;
          firstGameTime = state.gameTimeInSeconds;
          // Wait > 1 second, then push another state with a different card
          setTimeout(() => {
            s1.emit('pushState', {
              roomId,
              newState: {
                status: 'playing',
                currentCard: '300',  // Different card — should NOT reset gameActualStartTime
                cards: [],
                currentPlayerIndex: 0,
                round: 1,
                finished: false,
                gameTimeInSeconds: 999,  // Stale client value — server must override
                players: [{ name: 'Alice', deviceId: 'dev-gtp-a', score: 0 }],
              }
            });
          }, 1200);
        } else {
          // After 1.2s, server time must be >= 1 — proving gameActualStartTime was NOT reset
          expect(state.gameTimeInSeconds).toBeGreaterThanOrEqual(1);
          expect(state.gameTimeInSeconds).toBeLessThan(5);
          expect(state.gameTimeInSeconds).toBeGreaterThan(firstGameTime);

          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('promotes first connected player to host when host leaves, skipping disconnected players', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'HOST_REASSIGN_CONNECTED';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — disconnects (must NOT become host)
      const s3 = io(`http://127.0.0.1:${PORT}`); // Charlie — stays connected (must become host)

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        s3.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let bobDisconnected = false;
      let resolved = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-hrc-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-hrc-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId, name: 'Charlie', deviceId: 'dev-hrc-c', color: '#0000ff' }, () => {
              s2.disconnect(); // Bob disconnects unexpectedly
            });
          });
        });
      });

      // Wait until server marks Bob as disconnected, then Alice leaves.
      // Do NOT disconnect s1 immediately — the transport must stay open so
      // the server processes the leaveRoom event before the socket closes.
      s1.on('gameState', (state) => {
        const bob = state.players.find(p => p.name === 'Bob');
        if (bob && bob.disconnected && !bobDisconnected) {
          bobDisconnected = true;
          s1.emit('leaveRoom');
        }
      });

      // Charlie must receive his own socket ID as the new host
      s3.on('hostId', (newHostId) => {
        if (newHostId !== s3.id || resolved) return;
        resolved = true;
        expect(bobDisconnected).toBe(true); // Ensure Bob was disconnected first
        clearTimeout(timeoutId);
        s1.disconnect();
        s2.disconnect();
        s3.disconnect();
        resolve();
      });
    });
  }, 10000);

  it('does not auto-kick a disconnected player when reconnectTimeout is 0 (disabled)', () => {
    // reconnectTimeout=0 means "never kick automatically"; the buggy `|| 60` fallback would
    // treat 0 as 60 seconds instead. We verify no kick fires within a window that exceeds
    // the 1-second timer used in other kick tests.
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out'));
      }, 8000);

      let latestState = null;
      let bobDisconnectSeen = false;

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'RECONNECT_OFF', name: 'Alice', deviceId: 'dev-ro-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'RECONNECT_OFF', name: 'Bob', deviceId: 'dev-ro-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-ro-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob',   deviceId: 'dev-ro-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            s1.emit('pushState', {
              roomId: 'RECONNECT_OFF',
              newState: { players, status: 'playing', currentPlayerIndex: 0, reconnectTimeout: 0 },
            });
            setTimeout(() => s2.disconnect(), testDelay(300));
          });
        });
      });

      s1.on('gameState', (state) => {
        latestState = state;
        const bob = state.players?.find(p => p.name === 'Bob');
        if (bob?.disconnected && !bobDisconnectSeen) {
          bobDisconnectSeen = true;
          // Wait testDelay(350) — longer than scaled kick timer. Bob must remain in room.
          setTimeout(() => {
            expect(latestState.players.length).toBe(2);
            expect(latestState.players.find(p => p.name === 'Bob')?.disconnected).toBe(true);
            clearTimeout(timeoutId);
            s1.disconnect();
            resolve();
          }, testDelay(350));
        }
      });
    });
  }, 10000);

  it('rejects updateConfig with invalid initialCards (unknown type, negative count, non-integer, over limit)', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Test timed out waiting for invalid card rejection marker'));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CARDS_INVALID', name: 'Alice', deviceId: 'dev-ci-a', color: '#ff0000' }, () => {
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', initialCards: { injected: 5, '200': 5 } });
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', initialCards: { '200': -1 } });
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', initialCards: { '200': 1.5 } });
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', initialCards: { '200': 100 } });
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', initialCards: {} });

          // Marker: valid config update causes server to emit gameState with winningScore: 6000
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', winningScore: 6000 });
        });
      });

      s1.on('gameState', (state) => {
        const cards = state.initialCards;
        if (!cards) return;
        const hasUnknownKey = Object.keys(cards).some(k => !['Kleeblatt','Feuerwerk','Stop','Kniffel','Plus_Minus','x2','200','300','400','500','600'].includes(k));
        const hasNegative = Object.values(cards).some(v => v < 0);
        const hasNonInteger = Object.values(cards).some(v => !Number.isInteger(v));
        const hasOverLimit = Object.values(cards).some(v => v > 99);
        if (hasUnknownKey || hasNegative || hasNonInteger || hasOverLimit) {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error(`Server accepted invalid initialCards: ${JSON.stringify(cards)}`));
          return;
        }

        // Marker gameState arrived after all bad updateConfig attempts were processed and rejected
        if (state.winningScore === 6000) {
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('rejects an all-zero initialCards deck, which would leave currentCard permanently null', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Test timed out')); }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CARDS_ALL_ZERO', name: 'Alice', deviceId: 'dev-caz-a', color: '#ff0000' }, () => {
          const zeroDeck = { Kleeblatt: 0, Feuerwerk: 0, Stop: 0, Kniffel: 0, Plus_Minus: 0, x2: 0, '200': 0, '300': 0, '400': 0, '500': 0, '600': 0 };
          s1.emit('updateConfig', { roomId: 'CARDS_ALL_ZERO', initialCards: zeroDeck });
          // Follow with a distinguishable no-op config change so we get a gameState
          // to assert against once the (rejected) all-zero push has been processed.
          setTimeout(() => s1.emit('updateConfig', { roomId: 'CARDS_ALL_ZERO', winningScore: 7000 }), 200);
        });
      });

      s1.on('gameState', (state) => {
        if (state.winningScore !== 7000) return;
        const total = Object.values(state.initialCards).reduce((sum, v) => sum + v, 0);
        expect(total).toBeGreaterThan(0);
        clearTimeout(timeoutId);
        s1.disconnect();
        resolve();
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

  it('notifies the host when a new device tries to join using a disconnected player\'s name', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — will disconnect but not be kicked yet
      const s3 = io(`http://127.0.0.1:${PORT}`); // Charlie — tries to join as "Bob"

      const timeoutId = setTimeout(() => {
        s1.disconnect(); s2.disconnect(); s3.disconnect();
        reject(new Error('Timed out waiting for nameConflictWithDisconnected'));
      }, 6000);

      s1.on('nameConflictWithDisconnected', (name) => {
        expect(name).toBe('Bob');
        clearTimeout(timeoutId);
        s1.disconnect(); s2.disconnect(); s3.disconnect();
        resolve();
      });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'GHOST_NAME_ROOM', name: 'Alice', deviceId: 'dev-ghost-alice', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'GHOST_NAME_ROOM', name: 'Bob', deviceId: 'dev-ghost-bob', color: '#00ff00' }, () => {
            // reconnectTimeout is long enough that Bob stays a "ghost" (disconnected
            // but not yet spliced out) for the duration of this test. Room stays in
            // 'lobby' — matching the real scenario of someone closing their tab
            // before the game starts.
            s1.emit('updateConfig', { roomId: 'GHOST_NAME_ROOM', reconnectTimeout: 30 });

            setTimeout(() => {
              s2.disconnect();
              // Give the server a moment to process Bob's disconnect and mark him
              // before Charlie attempts to take his name.
              setTimeout(() => {
                s3.emit('joinRoom', { roomId: 'GHOST_NAME_ROOM', name: 'Bob', deviceId: 'dev-ghost-charlie', color: '#0000ff' }, (res) => {
                  expect(res.success).toBe(false);
                });
              }, 300);
            }, 200);
          });
        });
      });
    });
  }, 10000);

  it('does not notify the host when the conflicting name belongs to a still-connected player', () => {
    return new Promise((resolve) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — stays connected
      const s3 = io(`http://127.0.0.1:${PORT}`); // Charlie — tries to join as "Bob"

      let conflictNotified = false;
      s1.on('nameConflictWithDisconnected', () => { conflictNotified = true; });

      setTimeout(() => {
        expect(conflictNotified).toBe(false);
        s1.disconnect(); s2.disconnect(); s3.disconnect();
        resolve();
      }, 350);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'ACTIVE_NAME_ROOM', name: 'Alice', deviceId: 'dev-active-alice', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'ACTIVE_NAME_ROOM', name: 'Bob', deviceId: 'dev-active-bob', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId: 'ACTIVE_NAME_ROOM', name: 'Bob', deviceId: 'dev-active-charlie', color: '#0000ff' }, (res) => {
              expect(res.success).toBe(false);
              // Don't resolve here — wait out the timeout below to confirm no
              // nameConflictWithDisconnected event arrives after the rejection.
            });
          });
        });
      });
    });
  }, 10000);

  it('rejects a rejoining device renaming itself to a disconnected player\'s name', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host, will attempt the rename
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — disconnects, name stays reserved

      const timeoutId = setTimeout(() => {
        s1.disconnect(); s2.disconnect();
        reject(new Error('Timed out'));
      }, 6000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'RENAME_STEAL_ROOM', name: 'Alice', deviceId: 'dev-steal-alice', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'RENAME_STEAL_ROOM', name: 'Bob', deviceId: 'dev-steal-bob', color: '#00ff00' }, () => {
            // Long reconnectTimeout keeps Bob's seat (and name) reserved after
            // his socket drops.
            s1.emit('updateConfig', { roomId: 'RENAME_STEAL_ROOM', reconnectTimeout: 30 });

            setTimeout(() => {
              s2.disconnect();
              setTimeout(() => {
                // Alice's DEVICE rejoins under Bob's name. The reconnect path
                // (matched by deviceId) must reject it just like a fresh join
                // would — otherwise the room ends up with two "Bob"s once the
                // real Bob reconnects, and name-keyed state merging corrupts.
                s1.emit('joinRoom', { roomId: 'RENAME_STEAL_ROOM', name: 'Bob', deviceId: 'dev-steal-alice', color: '#ff0000' }, (res) => {
                  expect(res.success).toBe(false);
                  expect(res.error).toBe('Username already exists in this room');

                  // Rejoining under her own (unchanged) name still works.
                  s1.emit('joinRoom', { roomId: 'RENAME_STEAL_ROOM', name: 'Alice', deviceId: 'dev-steal-alice', color: '#ff0000' }, (res2) => {
                    expect(res2.success).toBe(true);
                    clearTimeout(timeoutId);
                    s1.disconnect(); s2.disconnect();
                    resolve();
                  });
                });
              }, 300);
            }, 200);
          });
        });
      });
    });
  }, 10000);

  it('kickPlayer aimed at a socket in a different room does not emit kicked to it', () => {
    return new Promise((resolve, reject) => {
      const hostA = io(`http://127.0.0.1:${PORT}`);   // host of room A — the attacker
      const hostB = io(`http://127.0.0.1:${PORT}`);   // host of room B
      const victimB = io(`http://127.0.0.1:${PORT}`); // member of room B — the target

      const cleanup = () => { hostA.disconnect(); hostB.disconnect(); victimB.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Timed out')); }, 6000);

      victimB.on('kicked', () => {
        clearTimeout(timeoutId);
        cleanup();
        reject(new Error('Victim in another room received kicked'));
      });

      hostA.on('connect', () => {
        hostA.emit('joinRoom', { roomId: 'XKICK_ROOM_A', name: 'Attacker', deviceId: 'dev-xkick-a', color: '#ff0000' }, () => {
          hostB.emit('joinRoom', { roomId: 'XKICK_ROOM_B', name: 'HostB', deviceId: 'dev-xkick-hb', color: '#00ff00' }, () => {
            victimB.emit('joinRoom', { roomId: 'XKICK_ROOM_B', name: 'Victim', deviceId: 'dev-xkick-v', color: '#0000ff' }, (res) => {
              const victimSocketId = res.socketId;

              hostA.emit('kickPlayer', victimSocketId);

              // Give a stray 'kicked' time to arrive, then confirm room B's
              // roster is untouched (the victim is still a member).
              setTimeout(() => {
                hostB.once('gameState', (state) => {
                  expect(state.players.length).toBe(2);
                  expect(state.players.some(p => p.name === 'Victim')).toBe(true);
                  clearTimeout(timeoutId);
                  cleanup();
                  resolve();
                });
                // updatePlayerColor triggers a fresh emitRoomState to assert on.
                hostB.emit('updatePlayerColor', { roomId: 'XKICK_ROOM_B', color: '#123456' });
              }, 800);
            });
          });
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

  it('reorderPlayers with a non-array newPlayers payload is ignored without crashing', () => {
    return new Promise((resolve) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        // No bad broadcast and server still responsive → pass.
        s1.disconnect();
        resolve();
      }, 350);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_NONARRAY', name: 'Alice', deviceId: 'dev-rna-a', color: '#ff0000' }, () => {
          // newPlayers is an object, not an array — must be ignored, not throw.
          s1.emit('reorderPlayers', { roomId: 'REORDER_NONARRAY', newPlayers: { foo: 'bar' } });
        });
      });

      s1.on('gameState', (state) => {
        // The single real player must remain intact.
        if (state.players && state.players.length !== 1) {
          clearTimeout(timeoutId);
          s1.disconnect();
          throw new Error('reorderPlayers with non-array payload altered the player list');
        }
      });
    });
  }, 10000);

  it('endGameStats accepts a write for the socket\'s own device', () => {
    return new Promise((resolve, reject) => {
      const deviceId = 'dev-egs-self';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 6000);

      // setupTests replaces global.fetch with a mock that only matches relative
      // URLs; the real implementation is preserved on global.__nativeFetch.
      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const pollStats = async () => {
        for (let i = 0; i < 20; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body && body.gamesPlayed >= 1) return body;
          await new Promise(r => setTimeout(r, 100));
        }
        return null;
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'EGS_SELF_ROOM', name: 'Alice', deviceId, color: '#ff0000' }, () => {
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

  it('ignores a duplicate endGameStats/submitGlobalStats for the same game (e.g. a reconnect after finish), but accepts them again once a new game starts', () => {
    return new Promise((resolve, reject) => {
      const deviceId = 'dev-egs-dedup';
      const roomId = 'EGS_DEDUP_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => { s1.disconnect(); reject(new Error('Timed out')); }, 10000);

      const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;
      const pollDeviceScore = async (expected) => {
        for (let i = 0; i < 30; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body?.totalScore === expected) return body;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`totalScore never reached ${expected}`);
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId, color: '#ff0000' }, async () => {
          try {
            // First submission for this game — recorded.
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

            // Start a new game in the same room — resets the per-game dedup.
            s1.emit('pushState', {
              roomId,
              newState: {
                players: [{ name: 'Alice', deviceId, socketId: s1.id, disconnected: false, score: 0 }],
                status: 'playing', currentPlayerIndex: 0,
              },
            });
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
        for (let i = 0; i < 30; i++) {
          if ((await getGlobalTotalScore()) === expected) return;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`global totalScore never reached ${expected}`);
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-sgs-dedup', color: '#ff0000' }, async () => {
          try {
            const before = await getGlobalTotalScore();

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
          }, 600);
        });
      });
    });
  }, 10000);

  it('accepts updateConfig with a fully valid initialCards configuration', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Server never accepted valid initialCards'));
      }, 3000);

      const validCards = {
        '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
        Stop: 3, Kleeblatt: 1, Feuerwerk: 2, Kniffel: 2, Plus_Minus: 2, x2: 2,
      };

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CARDS_VALID', name: 'Alice', deviceId: 'dev-cva-a', color: '#ff0000' }, () => {
          s1.emit('updateConfig', { roomId: 'CARDS_VALID', initialCards: validCards });
        });
      });

      s1.on('gameState', (state) => {
        if (state.initialCards?.['200'] === 5 && state.initialCards?.Stop === 3 && state.initialCards?.Kleeblatt === 1) {
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('closes room when all players passively disconnect and reconnectTimeout is 0', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'PASSIVE_DISCONNECT_0';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      let s2 = null;

      const cleanup = () => { s1.disconnect(); if (s2) s2.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 8000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-pdo-a', color: '#ff0000' }, () => {
          // Set reconnectTimeout to 0
          s1.emit('updateConfig', { roomId, reconnectTimeout: 0 });
          setTimeout(() => {
            s1.disconnect(); // passive disconnect
          }, 200);
        });
      });

      // Wait for the server to process the disconnect and delete the room.
      setTimeout(() => {
        s2 = io(`http://127.0.0.1:${PORT}`);
        s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-pdo-b', color: '#00ff00' }, () => {});

        s2.on('gameState', (freshState) => {
          // If the room was properly closed, it should be a fresh room with only Bob.
          // If the room leaked, Alice would still be in the state (as disconnected).
          expect(freshState.players.some((p) => p.name === 'Alice')).toBe(false);
          expect(freshState.players.some((p) => p.name === 'Bob')).toBe(true);
          clearTimeout(timeoutId);
          cleanup();
          resolve(undefined);
        });
      }, 1000);
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
        for (let i = 0; i < 30; i++) {
          const res = await realFetch(`http://127.0.0.1:${PORT}/api/stats/${deviceId}`);
          const body = await res.json();
          if (body?.totalScore === expected) return body;
          await new Promise(r => setTimeout(r, 100));
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
              await new Promise(r => setTimeout(r, 200));
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
              await new Promise(r => setTimeout(r, 200));

              // The new shuffle must be adopted, not discarded.
              expect(latestState.players.map((p) => p.name)).toEqual(['Bob', 'Alice']);

              // And stats for the new game must be accepted (dedup was reset).
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

  it('kicking a disconnected player cancels their reconnect timer, so a fresh rejoin is not removed by the stale timer', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'KICK_REJOIN_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — disconnects, gets kicked
      let s3 = null;                             // Bob again — fresh rejoin, same device
      const cleanup = () => { s1.disconnect(); s2.disconnect(); if (s3) s3.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 9000);

      let latestState = null;
      let kicked = false;
      s1.on('gameState', (state) => {
        latestState = state;
        const bob = state.players?.find((p) => p.name === 'Bob');
        if (bob?.disconnected && !kicked) {
          kicked = true;
          // Host kicks the disconnected Bob while his 1s reconnect timer is armed.
          s1.emit('kickPlayer', bob.socketId);
          setTimeout(() => {
            // Bob rejoins fresh (room is in lobby) with the SAME deviceId.
            s3 = io(`http://127.0.0.1:${PORT}`);
            s3.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-kr-b', color: '#00ff00' }, (res) => {
              expect(res.success).toBe(true);
              // Wait past the 200ms reconnect timer (1s * 0.2 scale): the stale timer must
              // NOT remove the rejoined Bob.
              setTimeout(() => {
                expect(latestState.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
                expect(latestState.players.find((p) => p.name === 'Bob')?.disconnected).toBe(false);
                clearTimeout(timeoutId);
                cleanup();
                resolve(undefined);
              }, 350);
            });
          }, 200);
        }
      });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-kr-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-kr-b', color: '#00ff00' }, () => {
            // 1s reconnect timer (pushState bounds allow 1; updateConfig would not).
            s1.emit('pushState', { roomId, newState: { reconnectTimeout: 1 } });
            setTimeout(() => s2.disconnect(), 200);
          });
        });
      });
    });
  }, 10000);

  it('host timeout promotes the first CONNECTED player, skipping disconnected ones', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'HOST_TIMEOUT_SKIP_DISC';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host, disconnects first
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — also disconnected (must NOT become host)
      const s3 = io(`http://127.0.0.1:${PORT}`); // Charlie — connected (must become host)
      const cleanup = () => { s1.disconnect(); s2.disconnect(); s3.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 9000);

      let latestHostId = null;
      let checked = false;
      s3.on('hostId', (id) => { latestHostId = id; });

      s3.on('gameState', (state) => {
        // Alice's 1s timer fired: she was removed while Bob is still marked
        // disconnected (his own timer fires ~600ms later). At this moment the
        // host must already be Charlie, not Bob's dead socket.
        const aliceGone = !state.players?.some((p) => p.name === 'Alice');
        const bobStillThere = state.players?.some((p) => p.name === 'Bob' && p.disconnected);
        if (aliceGone && bobStillThere && !checked) {
          checked = true;
          // hostId is emitted right after gameState — give it a moment, but stay
          // well below the ~600ms window before Bob's own timer self-heals it.
          setTimeout(() => {
            expect(latestHostId).toBe(s3.id);
            clearTimeout(timeoutId);
            cleanup();
            resolve(undefined);
          }, 200);
        }
      });

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-hts-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-hts-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId, name: 'Charlie', deviceId: 'dev-hts-c', color: '#0000ff' }, () => {
              s1.emit('pushState', { roomId, newState: { reconnectTimeout: 1 } });
              setTimeout(() => s1.disconnect(), 100);      // Alice's timer fires at ~300ms (100ms + 200ms scaled timeout)
              setTimeout(() => s2.disconnect(), 250);      // Bob's timer fires at ~450ms (250ms + 200ms scaled timeout)
            });
          });
        });
      });
    });
  }, 10000);

  it('a fired reconnect timer cleans up its bookkeeping entry, so the room is still deleted when the last connected player leaves', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'STALE_TIMER_LEAK_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — times out (leaves a fired timer behind)
      const s3 = io(`http://127.0.0.1:${PORT}`); // Charlie — passively disconnects (timeout 0)
      const s4 = io(`http://127.0.0.1:${PORT}`); // Dave — explicit-leaves last
      let s5 = null;                             // Eve — probes whether the room leaked
      const cleanup = () => { s1.disconnect(); s2.disconnect(); s3.disconnect(); s4.disconnect(); if (s5) s5.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 12000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-stl-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-stl-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId, name: 'Charlie', deviceId: 'dev-stl-c', color: '#0000ff' }, () => {
              s4.emit('joinRoom', { roomId, name: 'Dave', deviceId: 'dev-stl-d', color: '#00ffff' }, async () => {
                try {
                  // Marker config so a leaked room is distinguishable from a fresh one.
                  s1.emit('pushState', { roomId, newState: { winningScore: 7777, reconnectTimeout: 1 } });
                  await new Promise(r => setTimeout(r, testDelay(200)));

                  // Bob times out — his fired timer must not leave a stale entry.
                  s2.disconnect();
                  await new Promise(r => setTimeout(r, testDelay(350)));

                  // Disable reconnect timers, then Alice and Charlie passively
                  // disconnect (marked disconnected, no timers armed).
                  s1.emit('pushState', { roomId, newState: { reconnectTimeout: 0 } });
                  await new Promise(r => setTimeout(r, testDelay(200)));
                  s1.disconnect();
                  await new Promise(r => setTimeout(r, testDelay(300)));
                  s3.disconnect();
                  await new Promise(r => setTimeout(r, testDelay(300)));

                  // Dave explicit-leaves: everyone remaining is disconnected and no
                  // timers are pending, so the room must be deleted.
                  s4.emit('leaveRoom');
                  await new Promise(r => setTimeout(r, testDelay(300)));

                  // Probe: a new join must land in a FRESH room (default config,
                  // sole member = host), not the leaked one.
                  s5 = io(`http://127.0.0.1:${PORT}`);
                  s5.emit('joinRoom', { roomId, name: 'Eve', deviceId: 'dev-stl-e', color: '#123456' }, (res) => {
                    expect(res.success).toBe(true);
                    expect(res.isHost).toBe(true);
                  });
                  s5.on('gameState', (state) => {
                    expect(state.players.map((p) => p.name)).toEqual(['Eve']);
                    expect(state.winningScore).toBe(6000);
                    clearTimeout(timeoutId);
                    cleanup();
                    resolve(undefined);
                  });
                } catch (e) {
                  clearTimeout(timeoutId);
                  cleanup();
                  reject(e);
                }
              });
            });
          });
        });
      });
    });
  }, 14000);

  it('tolerates malformed (null/primitive) socket payloads and custom objects without crashing the server', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'MALFORMED_PAYLOAD_TEST_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const cleanup = () => { s1.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 6000);

      s1.on('connect', () => {
        // Emit null to joinRoom
        s1.emit('joinRoom', null, (res) => {
          expect(res.success).toBe(false);
          
          // Join properly
          s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-mal-a', color: '#ff0000' }, (res2) => {
            expect(res2.success).toBe(true);

            // Send malformed configs, colors, reactions, and pushState
            s1.emit('updateConfig', null);
            s1.emit('updateConfig', 'string-payload');
            s1.emit('reorderPlayers', null);
            s1.emit('updatePlayerColor', null);
            s1.emit('updatePlayerColor', { roomId, color: null });
            s1.emit('updatePlayerColor', { roomId, color: { toString: () => { throw new Error('crash') } } });
            s1.emit('sendReaction', null);
            s1.emit('pushState', null);
            s1.emit('submitGlobalStats', null);
            s1.emit('endGameStats', null);

            // Wait a moment and verify that the server is still running and responsive
            setTimeout(() => {
              s1.emit('updateConfig', { roomId, winningScore: 5000 });
              setTimeout(() => {
                clearTimeout(timeoutId);
                cleanup();
                resolve(undefined);
              }, 300);
            }, 500);
          });
        });
      });
    });
  });

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
