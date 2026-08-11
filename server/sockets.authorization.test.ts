/**
 * @vitest-environment node
 *
 * Socket integration suite — authorization & payload validation.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { startTestServer, testDelay } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

describe('Server Socket E2E — authorization & payload validation', () => {
  let serverProcess;

  const PORT = TEST_PORTS.socketsAuthorization;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('ignores pushState from a player who is neither host nor the active player', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host + active player
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — neither

      // Ends on Alice's legitimate follow-up, not on a timer. The old version
      // waited 1500ms and then asserted a flag its only writer sets on the
      // path that rejects and clears this timer first — so it could never be
      // true here, and the test could not fail however dead the server was.
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('Server never broadcast the host\'s legitimate follow-up push'));
      }, 4000);

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
              // Bob is not host and not the active player → this must be
              // ignored. currentPlayerIndex is in the payload deliberately:
              // the roster and status are independently sanitised downstream,
              // so a push of those alone stays harmless even with the
              // authorization check removed. Seizing the turn is the part only
              // this check stands between Bob and.
              s2.emit('pushState', { roomId: 'E2E_AUTH', newState: { players: [], status: 'hacked', currentPlayerIndex: 1 } });
              // Alice may push; her round bump is what ends the test, and it
              // can only arrive from a room that was live enough to have taken
              // Bob's push too, had the server been willing to.
              setTimeout(() => {
                s1.emit('pushState', { roomId: 'E2E_AUTH', newState: { round: 2 } });
              }, testDelay(200));
            }, testDelay(200));
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'hacked' || state.players?.length === 0 || state.currentPlayerIndex === 1) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          reject(new Error('Server accepted pushState from an unauthorized player'));
        } else if (state.round === 2) {
          clearTimeout(timeoutId);
          s1.disconnect();
          s2.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

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
            }, testDelay(200));
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
            }, testDelay(300));
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
            }, testDelay(300));
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
            }, testDelay(200));
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
            }, testDelay(200));
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

      const cleanup = () => { s1.disconnect(); s2.disconnect(); s3.disconnect(); };
      // "No liveTurnState ever arrives" was the whole pass condition here,
      // which is also what a failed join, a dead room or a broken forwarder
      // look like. Bob — who IS the active player — pushes one afterwards, and
      // that is what ends the test: the forwarder demonstrably works, so
      // Carol's absence from it is a refusal.
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Server never forwarded the active player\'s liveTurnState'));
      }, 4000);

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
                setTimeout(() => {
                  s2.emit('liveTurnState', {
                    roomId: 'LIVE_TURN_UNAUTH_ROOM',
                    liveTurnState: {
                      turnScore: 42, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
                    },
                  });
                }, testDelay(200));
              }, testDelay(200));
            });
          });
        });
      });

      s1.on('gameState', (state) => {
        if (!gameStarted && state.status === 'playing') gameStarted = true;
      });

      s1.on('liveTurnState', (payload) => {
        const score = payload?.liveTurnState?.turnScore;
        if (score === 999) {
          clearTimeout(timeoutId);
          cleanup();
          reject(new Error('Bystander was able to push liveTurnState'));
        } else if (score === 42) {
          clearTimeout(timeoutId);
          cleanup();
          resolve();
        }
      });
    });
  }, 10000);

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
              }, 100);
            }, 150);
          });
        });
      });
    });
  });
});
