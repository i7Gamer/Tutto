/**
 * @vitest-environment node
 *
 * Socket integration suite — presence, kicks & host promotion.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { startTestServer, testDelay } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

describe('Server Socket E2E — presence, kicks & host promotion', () => {
  let serverProcess;
  let socket1;
  let socket2;

  const PORT = TEST_PORTS.socketsPresence;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (socket1) socket1.disconnect();
    if (socket2) socket2.disconnect();
    if (serverProcess) serverProcess.kill();
  });

  /**
   * Wraps a socket listener that asserts.
   *
   * An expect() throwing inside one is an unhandled listener error, not a
   * rejected test: the promise never settles, and the failure surfaces as this
   * suite's generic "Test timed out" with the actual assertion message lost.
   * Routing the throw to reject keeps it. (sockets.room.test.ts already does
   * this inline; this is the same thing, once.)
   */
  const asserting = (reject, listener) => (...args) => {
    try {
      listener(...args);
    } catch (e) {
      reject(e);
    }
  };

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
            }, testDelay(100));
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
            }, testDelay(300));
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
              }, testDelay(300));
            });
          });
        });
      });

      s1.on('gameState', asserting(reject, (state) => {
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
      }));
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
            setTimeout(() => s2.emit('leaveRoom'), testDelay(200));
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', asserting(reject, (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          expect(state.currentPlayerIndex).toBeNull();
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      }));
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
            setTimeout(() => s2.disconnect(), testDelay(200));
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', asserting(reject, (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      }));
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
            setTimeout(() => s1.emit('kickPlayer', s2.id), testDelay(200));
          });
        });
      });

      s1.on('gameAborted', () => { abortReceived = true; });

      s1.on('gameState', asserting(reject, (state) => {
        if (abortReceived && state.status === 'lobby' && state.players?.length === 1) {
          expect(state.players[0].name).toBe('Alice');
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      }));
    });
  }, 10000);

  // 'gameTimeInSeconds is server-calculated and increases monotonically
  // across pushState calls' moved to socketHandlers.test.ts's in-process
  // 'game clock' suite, which backdates the server's gameActualStartTime
  // anchor instead of sleeping real wall-clock seconds.

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
          // reconnectTimeout: 0 means the server never arms a kick timer, so Bob stays
          // disconnected indefinitely. testDelay(350) gives the server time to process the
          // disconnect event and emit the updated gameState — no kick can fire anyway.
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
              }, testDelay(300));
            }, testDelay(200));
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
              }, 200);
            });
          });
        });
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
          }, testDelay(200));
        });
      });

      // Wait for the server to process the disconnect and delete the room.
      // reconnectTimeout=0 deletes the room synchronously in the disconnect
      // handler (no timer involved), so a short margin is enough.
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
      }, 300);
    });
  }, 10000);

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
            setTimeout(() => s2.disconnect(), testDelay(200));
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

      // The scenario only exists inside one window: Alice must disconnect
      // first, and Bob's disconnect must reach the server BEFORE Alice's
      // removal timer fires — otherwise Bob is still connected when she is
      // removed and the server promotes HIM, correctly, and this test is
      // measuring something else entirely.
      //
      // Both halves of that used to be wall-clock guesses (disconnect at 100ms
      // and 250ms against a 200ms timer), so the ordering held by 50ms and
      // inverted under load. Bob now disconnects on seeing Alice marked
      // disconnected — one round trip after her, whatever the machine is
      // doing — and the timer is five times longer, so the window it has to
      // land in is ~1s rather than 50ms.
      //
      // 5s (pushState's bounds allow it; updateConfig would not) = 1s scaled.
      const RECONNECT_SECONDS = 5;
      let aliceDropped = false;
      let bobDropped = false;
      let sawAliceRemoved = false;
      let checked = false;

      // Every step waits for the broadcast proving the previous one landed, so
      // the only clock left is the server's own removal timer.
      s3.on('gameState', asserting(reject, (state) => {
        if (!aliceDropped) {
          // Not before the longer timeout is in force: on the default 60s
          // Alice is never removed at all and this test just times out.
          if (state.reconnectTimeout !== RECONNECT_SECONDS) return;
          aliceDropped = true;
          s1.disconnect();
          return;
        }

        const alice = state.players?.find((p) => p.name === 'Alice');
        const bob = state.players?.find((p) => p.name === 'Bob');

        if (!bobDropped) {
          if (!alice?.disconnected) return;
          bobDropped = true;
          s2.disconnect();
          return;
        }

        if (alice || checked) return;

        // Alice is gone. Bob has to still be here and still be marked
        // disconnected, or the setup lost its race and the assertion below
        // would be objecting to a promotion that is actually correct.
        expect(bob, 'Bob was removed before Alice — their timers interleaved').toBeDefined();
        expect(bob?.disconnected, 'Bob was still connected when Alice was removed, so promoting him is right — this run proves nothing').toBe(true);
        sawAliceRemoved = true;
      }));

      // hostId rides along with every gameState (emitRoomState sends the two
      // back to back), so this checks the id paired with the very broadcast
      // that showed Alice gone. The old version read the latest id 200ms
      // later, which was a straight race with Bob's own removal timer — that
      // timer self-heals the host, so a slow assertion passed and a prompt one
      // failed, for identical server behaviour.
      s3.on('hostId', asserting(reject, (id) => {
        if (!sawAliceRemoved || checked) return;
        checked = true;
        // Bob is disconnected, so the promotion must have skipped him.
        expect(id).toBe(s3.id);
        clearTimeout(timeoutId);
        cleanup();
        resolve(undefined);
      }));

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-hts-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-hts-b', color: '#00ff00' }, () => {
            s3.emit('joinRoom', { roomId, name: 'Charlie', deviceId: 'dev-hts-c', color: '#0000ff' }, () => {
              s1.emit('pushState', { roomId, newState: { reconnectTimeout: RECONNECT_SECONDS } });
            });
          });
        });
      });
    });
  }, 10000);

  // With the kick timer disabled nobody is ever removed automatically, so a
  // dead host's seat can only be freed by a manual kick — which needs a host.
  // The disconnect path used to return before any failover, leaving the room
  // owned by a socket that no longer exists: no config, no kick, no restart,
  // no global-stats submission, and no way back short of everyone leaving.
  it('hands the room over when the host drops and the kick timer is disabled', () => {
    return new Promise((resolve, reject) => {
      const roomId = 'HOSTLESS_NO_KICK_TIMER';
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host, drops
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — connected, must inherit
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => { cleanup(); reject(new Error('Test timed out')); }, 9000);

      let aliceDropped = false;
      let checked = false;

      s2.on('gameState', asserting(reject, (state) => {
        if (!aliceDropped) {
          if (state.reconnectTimeout !== 0) return;
          aliceDropped = true;
          s1.disconnect();
          return;
        }
        const alice = state.players?.find((p) => p.name === 'Alice');
        if (!alice?.disconnected || checked) return;
        checked = true;
        // Alice keeps her seat (that is what a disabled kick timer means) —
        // what must not survive is her ownership of the room.
        expect(state.players).toHaveLength(2);
      }));

      s2.on('hostId', asserting(reject, (id) => {
        if (!checked) return;
        expect(id, 'the room is still owned by the dropped host').toBe(s2.id);
        clearTimeout(timeoutId);
        cleanup();
        resolve(undefined);
      }));

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-hl-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId, name: 'Bob', deviceId: 'dev-hl-b', color: '#00ff00' }, () => {
            // "Kick Timer: Disabled" from the lobby's advanced panel.
            s1.emit('updateConfig', { roomId, reconnectTimeout: 0 });
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
});
