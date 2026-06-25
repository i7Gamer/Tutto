/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { spawn } from 'child_process';

describe('Server Socket E2E Simulation', () => {
  let serverProcess;
  let socket1;
  let socket2;

  // We will run the server on port 3005 for testing
  const PORT = '3005';

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn('node', ['server/index.js'], {
        env: { ...process.env, PORT },
        stdio: 'pipe'
      });

      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Server running on port')) {
          resolve();
        }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error('Server stderr:', data.toString());
      });

      serverProcess.on('error', (err) => {
        reject(err);
      });
    });
  }, 10000);

  afterAll(() => {
    if (socket1) socket1.disconnect();
    if (socket2) socket2.disconnect();
    if (serverProcess) serverProcess.kill();
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
        socket1.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, (res) => {
          expect(res.success).toBe(true);
          
          socket2.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Bob', deviceId: 'dev-bob', color: '#00ff00' }, (res2) => {
            expect(res2.success).toBe(true);
            
            // Simulating Alice explicitly pushing state to start game
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-alice', socketId: socket1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-bob', socketId: socket2.id, disconnected: false, score: 0 }
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
        s1.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Alice', deviceId: 'dev-alice2', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Bob', deviceId: 'dev-bob2', color: '#00ff00' }, () => {
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-alice2', socketId: s1.id, disconnected: false, score: 0 },
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

  it('rejects invalid color strings in updatePlayerColor', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      let timeoutId = setTimeout(() => {
        s1.disconnect();
        resolve(); // If no invalid color was broadcasted, we pass
      }, 1000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'COLOR_ROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, () => {
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
      }, 1000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CONFIG_ROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, () => {
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
      }, 1500);

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
          // The server must have kept the real score (0) and real deviceId, not the injected values.
          expect(state.players[0].score).toBe(0);
          expect(state.players[0].deviceId).toBe('dev-ri-a');
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
      }, 1000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_ROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, () => {
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

  it('reorderPlayers is blocked when the game is already playing', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob

      const timeoutId = setTimeout(() => {
        // If no state change was received with reordered players after game start, the test passes
        s1.disconnect();
        s2.disconnect();
        resolve();
      }, 2000);

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

  it('active player cannot spoof scores for other players via pushState', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player, will try to tamper

      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Test timed out'));
      }, 4000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'SCORE_SPOOF_ROOM', name: 'Alice', deviceId: 'dev-ss-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'SCORE_SPOOF_ROOM', name: 'Bob', deviceId: 'dev-ss-b', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-ss-a', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-ss-b', socketId: s2.id, disconnected: false, score: 0 },
            ];
            // Host gives Bob the active turn (index 1)
            s1.emit('pushState', { roomId: 'SCORE_SPOOF_ROOM', newState: { players, status: 'playing', currentPlayerIndex: 1 } });

            setTimeout(() => {
              // Bob (active player) pushes a state that inflates Alice's score to 99999
              s2.emit('pushState', {
                roomId: 'SCORE_SPOOF_ROOM',
                newState: {
                  players: [
                    { name: 'Alice', deviceId: 'dev-ss-a', socketId: s1.id, disconnected: false, score: 99999 },
                    { name: 'Bob', deviceId: 'dev-ss-b', socketId: s2.id, disconnected: false, score: 500 },
                  ],
                  currentPlayerIndex: 0,
                }
              });
            }, 300);

            setTimeout(() => {
              // After Bob's tamper attempt, Alice's score must still be 0
              s1.emit('pushState', { roomId: 'SCORE_SPOOF_ROOM', newState: {} }); // no-op, just trigger state read
            }, 600);
          });
        });
      });

      let gameStarted = false;
      s1.on('gameState', (state) => {
        if (state.status === 'playing' && state.players?.length === 2) {
          gameStarted = true;
        }
        if (gameStarted && state.players) {
          const alice = state.players.find(p => p.name === 'Alice');
          if (alice && alice.score === 99999) {
            clearTimeout(timeoutId);
            s1.disconnect();
            s2.disconnect();
            reject(new Error('Server allowed active player to spoof another player\'s score'));
          }
          // After Bob's push, Bob should have 500 (own row), Alice stays 0
          const bob = state.players.find(p => p.name === 'Bob');
          if (alice && bob && alice.score === 0 && bob.score === 500) {
            clearTimeout(timeoutId);
            s1.disconnect();
            s2.disconnect();
            resolve();
          }
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
                  liveTurnState: { turnScore: 350, keptDice: [{ val: 1 }], currentRoll: [{ val: 5, selected: false }] },
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
});
