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
              // ignored. The payload is a lone currentPlayerIndex on purpose:
              // an earlier version also sent `players: []`, and the roster
              // gate in applyPushedState discards any push whose roster does
              // not match BEFORE the authorization line is consulted — so that
              // push was refused with or without the check, and deleting the
              // check left every server test green. Seizing the turn is the
              // one thing nothing but the authorization line stands between
              // Bob and.
              s2.emit('pushState', { roomId: 'E2E_AUTH', newState: { currentPlayerIndex: 1 } });
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
        if (state.currentPlayerIndex === 1) {
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

  it('does not deliver a room named after a socket id to that socket', async () => {
    // socket.io auto-joins every socket to a room named its own id
    // (`this.join(this.id)` in Socket._onconnect), and joinRoom accepts any
    // 1-100 char string as a roomId — so if rooms broadcast on the bare id,
    // the two namespaces are one. `players[].socketId` rides every gameState
    // (sanitizePlayerForBroadcast strips only deviceId), so any co-member can
    // read a victim id, join a "room" named after it from a second
    // connection, and have every io.to(...) send for that fake room delivered
    // into the victim client — which applies a gameState wholesale
    // (socketSlice.ts GAME_STATE_SYNC_KEYS), taking over roster, status,
    // currentPlayerIndex and isHost.
    //
    // Resolves with what it OBSERVED and asserts afterwards, rather than
    // reject-on-bad-event with a bare timeout for success. That shape carried
    // no expect() at all: nothing proved the attacker ever joined or pushed,
    // so a slow connect, a refused join, or an ack that never fired all read
    // as "the attack did not land" — for a security test, the one failure
    // mode worth ruling out.
    const observed = await new Promise((resolve, reject) => {
      const victim = io(`http://127.0.0.1:${PORT}`);
      const attacker = io(`http://127.0.0.1:${PORT}`);
      const seen = { attackerJoined: false, attackerPushed: false, foreign: null };

      const giveUp = setTimeout(() => {
        victim.disconnect();
        attacker.disconnect();
        reject(new Error('the attack was never staged — a seat was never taken'));
      }, 8000);

      const finish = () => {
        clearTimeout(giveUp);
        victim.disconnect();
        attacker.disconnect();
        resolve(seen);
      };

      victim.on('connect', () => {
        victim.emit('joinRoom', { roomId: 'E2E_NS_VICTIM', name: 'Victim', deviceId: 'dev-ns-v' }, (ack) => {
          const victimSocketId = ack.socketId;

          // Only now: the victim own join broadcast is already delivered, so
          // anything arriving after this point came from the attacker room.
          victim.on('gameState', (state) => {
            if (state.players?.some(p => p.name === 'Attacker')) {
              seen.foreign = 'a gameState carrying the attacker roster';
            }
          });
          victim.on('hostId', (hostSocketId) => {
            if (hostSocketId !== victimSocketId) {
              seen.foreign = `a foreign hostId (${hostSocketId}), which would flip isHost`;
            }
          });

          attacker.emit(
            'joinRoom',
            { roomId: victimSocketId, name: 'Attacker', deviceId: 'dev-ns-a' },
            (attackerAck) => {
              // The join itself may legitimately succeed (the id is just a
              // string); what must not happen is its broadcast reaching the
              // victim. Push too, so a second emit has to stay contained.
              seen.attackerJoined = attackerAck.success === true;
              if (seen.attackerJoined) {
                attacker.emit('pushState', {
                  roomId: victimSocketId,
                  newState: { status: 'playing', currentPlayerIndex: 0 },
                });
                seen.attackerPushed = true;
              }
              // The quiet window starts HERE — after the attack — not at the
              // top of the test, where it raced the whole setup chain.
              setTimeout(finish, 600);
            },
          );
        });
      });
    });

    expect(observed.attackerJoined, 'the attacker never got into the room, so nothing was tested').toBe(true);
    expect(observed.attackerPushed, 'the attacker never pushed, so the broadcast under test never happened').toBe(true);
    expect(observed.foreign, 'a broadcast for the attacker room reached the victim').toBeNull();
  }, 15000);

  it('rejects pushState of host-only fields (status, winningScore) from a non-host active player', async () => {
    // Same restructure as the namespace test above, for a sharper reason: the
    // assertion used to sit inside the success timer, reading a flag that only
    // the REJECT path ever set — and that path cleared the timer first. It was
    // structurally unable to observe true. Both preconditions are asserted too,
    // so a setup that never started the game cannot read as "the push was
    // refused".
    const observed = await new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — active player, not host
      const seen = { gameStarted: false, bobPushed: false, accepted: null };

      const giveUp = setTimeout(() => {
        s1.disconnect();
        s2.disconnect();
        reject(new Error('the setup never completed — a seat was never taken'));
      }, 8000);

      s1.on('gameState', (state) => {
        if (state.status === 'playing' && state.currentPlayerIndex === 1) seen.gameStarted = true;
        // Sentinels that are VALID values Bob simply may not write. The pair
        // used to be status:'hacked' and winningScore:1 — but 'hacked' is not
        // one of the two legal statuses and 1 is below MIN_WINNING_SCORE, so
        // both were refused by the VALUE checks whatever the permission set
        // said. Opening every field to the active player left this test green.
        // Nothing in normal play sends either from this seat: only the host
        // returns a running game to the lobby, and only the host sets the
        // winning score.
        // Only once the game is running: 'lobby' is also what the room
        // broadcasts while the two seats are still joining.
        if (seen.gameStarted && (state.status === 'lobby' || state.winningScore === 7777)) {
          seen.accepted = `status=${state.status} winningScore=${state.winningScore}`;
        }
      });

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
              s2.emit('pushState', { roomId: 'E2E_HOSTFIELDS', newState: { status: 'lobby', winningScore: 7777 } });
              seen.bobPushed = true;
              setTimeout(() => {
                clearTimeout(giveUp);
                s1.disconnect();
                s2.disconnect();
                resolve(seen);
              }, 350);
            }, testDelay(200));
          });
        });
      });
    });

    expect(observed.gameStarted, 'the game never started with Bob active, so he was never the active player').toBe(true);
    expect(observed.bobPushed, 'Bob never sent the push under test').toBe(true);
    expect(observed.accepted, 'the server accepted host-only fields from a non-host active player').toBeNull();
  }, 15000);

  it('non-host active player can deduct Plus_Minus score from the host-leader', () => {
    // Regression test: a non-host active player can write to the host's row for
    // score and times1000PointsDeducted (PLAYER_CROSS_SEAT_MUTABLE in pushValidation.ts).
    // The Plus_Minus -1000 deduction applies this cross-seat write path.
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

  it('tolerates malformed (null/primitive) socket payloads and keeps serving', async () => {
    // The old version emitted the crash attempts and then resolved on a timer
    // with no listener, no assertion on the result and no liveness check — so
    // a server that had actually died passed it. It was also the last test in
    // the file, so nothing downstream noticed either.
    //
    // Liveness is now asserted twice, from both sides: a legitimate
    // updateConfig must still be ACCEPTED AND BROADCAST after the burst, and
    // the process must still be running.
    //
    // Worth knowing what this does NOT prove: every payload below is refused
    // by a type guard before it can throw — updatePlayerColor returns on
    // `typeof color !== 'string'` without ever reaching COLOR_RE, so even the
    // throwing toString is never called. Removing safeOn's catch leaves this
    // test green. That is a property of the handlers being well guarded, not
    // a gap here; safeOn's containment needs a handler that genuinely throws,
    // and no client-supplied payload reaches one.
    const observed = await new Promise((resolve, reject) => {
      const roomId = 'MALFORMED_PAYLOAD_TEST_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const seen = { nullJoinRefused: false, joined: false, stillServing: false };

      const giveUp = setTimeout(() => {
        s1.disconnect();
        reject(new Error('the server never answered the initial join'));
      }, 8000);

      s1.on('gameState', (state) => {
        if (state.winningScore === 5000) seen.stillServing = true;
      });

      s1.on('connect', () => {
        // Emit null to joinRoom
        s1.emit('joinRoom', null, (res) => {
          seen.nullJoinRefused = res.success === false;

          // Join properly
          s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-mal-a', color: '#ff0000' }, (res2) => {
            seen.joined = res2.success === true;

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

            // Then a well-formed one: its broadcast is the proof the server is
            // not merely un-crashed but still SERVING this room.
            setTimeout(() => {
              s1.emit('updateConfig', { roomId, winningScore: 5000 });
              setTimeout(() => {
                clearTimeout(giveUp);
                s1.disconnect();
                resolve(seen);
              }, 300);
            }, 150);
          });
        });
      });
    });

    expect(observed.nullJoinRefused, 'a null joinRoom must be refused, not accepted').toBe(true);
    expect(observed.joined, 'the well-formed join never succeeded, so nothing was tested').toBe(true);
    expect(observed.stillServing, 'the server stopped answering after the malformed burst').toBe(true);
    expect(serverProcess.exitCode, 'the server process died on a malformed payload').toBeNull();
  }, 15000);
});
