/**
 * @vitest-environment node
 *
 * Socket integration suite — configuration & player order.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { startTestServer, testDelay } from './socketTestHarness';

describe('Server Socket E2E — configuration & player order', () => {
  let serverProcess;

  // Unique to this file: every socket suite spawns its own server, so ports must
  // not collide with any other server test (3005-3013 are already taken).
  const PORT = '3014';

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, 20000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

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
          }, testDelay(200));
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
            }, testDelay(300));
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
          }, testDelay(300));
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

          // Marker: valid config update with a non-default winningScore (5999 ≠ DEFAULT_WINNING_SCORE=6000).
          // The server emits a gameState after processing this, proving all prior bad payloads were handled.
          s1.emit('updateConfig', { roomId: 'CARDS_INVALID', winningScore: 5999 });
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

        // Marker gameState: server has drained all prior socket events. All bad cards updates were rejected.
        if (state.winningScore === 5999) {
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
});
