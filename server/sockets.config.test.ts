/**
 * @vitest-environment node
 *
 * Socket integration suite — configuration & player order.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { protocolClient as io, joinTestRoom, acceptOnlineAction, requestPublicState, configureTestRoom } from './onlineTestClient';
import { startTestServer, testDelay, connected } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import { nonNull } from '../src/testing/factories';

describe('Server Socket E2E — configuration & player order', () => {
  let serverProcess: ChildProcess | undefined;

  const PORT = TEST_PORTS.socketsConfig;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  // Every "the server must ignore this" test below ends on a legitimate
  // follow-up the server MUST honour, never on a timer.
  //
  // Resolving on a timer is not a test: it holds equally well when the join
  // failed, the room never existed, or the server answered nothing at all — the
  // suite would stay green with the rejected event never sent. Ending instead
  // on a valid follow-up through the SAME handler proves the path was live, so
  // the silence being asserted is a rejection rather than an absence.
  it('rejects invalid color strings in updatePlayerColor', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Server never broadcast the valid follow-up color'));
      }, 3000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'COLOR_ROOM', name: 'Alice', deviceId: 'dev-color-alice', color: '#ff0000' }, () => {
          s1.emit('updatePlayerColor', { roomId: 'COLOR_ROOM', color: 'invalid-color' });
          // Spaced so each event gets its own broadcast: sent back to back, a
          // wrongly-accepted first color could be masked by the second.
          setTimeout(() => {
            s1.emit('updatePlayerColor', { roomId: 'COLOR_ROOM', color: '#00ff00' });
          }, testDelay(200));
        });
      });

      s1.on('gameState', (state) => {
        const color = state.players?.[0]?.color;
        if (color === 'invalid-color') {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server accepted invalid color string'));
        } else if (color === '#00ff00') {
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('ignores updateConfig with out-of-bounds values', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => {
        s1.disconnect();
        reject(new Error('Server never broadcast the valid follow-up config'));
      }, 3000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'CONFIG_ROOM', name: 'Alice', deviceId: 'dev-configbounds-alice', color: '#ff0000' }, () => {
          s1.emit('updateConfig', { roomId: 'CONFIG_ROOM', winningScore: -100, turnDuration: 9999, reconnectTimeout: -5 });
          setTimeout(() => {
            s1.emit('updateConfig', { roomId: 'CONFIG_ROOM', winningScore: 5000 });
          }, testDelay(200));
        });
      });

      s1.on('gameState', (state) => {
        if (state.winningScore === -100 || state.turnDuration === 9999 || state.reconnectTimeout === -5) {
          clearTimeout(timeoutId);
          s1.disconnect();
          reject(new Error('Server accepted out-of-bounds config'));
        } else if (state.winningScore === 5000) {
          clearTimeout(timeoutId);
          s1.disconnect();
          resolve();
        }
      });
    });
  }, 10000);

  it('starts from the canonical lobby order and ignores injected player and chart fields', async () => {
    const roomId = 'E2E_STARTORDER';
    const host = io(`http://127.0.0.1:${PORT}`);
    const guest = io(`http://127.0.0.1:${PORT}`);
    try {
      await joinTestRoom(host, roomId, 'Alice', { randomOrder: false, turnDuration: 0 });
      await joinTestRoom(guest, roomId, 'Bob');
      host.emit('reorderPlayers', { roomId, newPlayers: [{ name: 'Bob' }, { name: 'Alice' }] });
      await requestPublicState(host, roomId);
      const state = await acceptOnlineAction(host, roomId, { type: 'start' }, {
        players: [{ name: 'Alice', score: 99999 }, { name: 'Bob', score: 99999 }],
        chartNames: ['forged'], chartValues: [[99999]], chartLabels: [9],
      });
      expect(state.players?.map(player => player.name)).toEqual(['Bob', 'Alice']);
      expect(state.players?.map(player => player.socketId)).toEqual([guest.id, host.id]);
      expect(state.players?.map(player => player.score)).toEqual([0, 0]);
      expect(state.players?.every(player => !('deviceId' in player))).toBe(true);
      expect(state.chartNames).toEqual(['Bob', 'Alice']);
      expect(state.chartValues).toEqual([[], []]);
    } finally { host.disconnect(); guest.disconnect(); }
  });

  it('reorderPlayers preserves server-side player objects, ignoring injected client fields', () => {
    return new Promise<void>((resolve, reject) => {
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
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Server never applied the valid follow-up reorder'));
      }, 3000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_ROOM', name: 'Alice', deviceId: 'dev-reorder-alice', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'REORDER_ROOM', name: 'Bob', deviceId: 'dev-reorder-bob', color: '#00ff00' }, () => {
            // Well-formed but one seat short of the room's two players. The
            // payload used to be a bare `[]`, which the handler discards at its
            // shape guard for want of a roomId — the length check this test is
            // named after was never reached.
            s1.emit('reorderPlayers', { roomId: 'REORDER_ROOM', newPlayers: [{ name: 'Alice' }] });
            setTimeout(() => {
              s1.emit('reorderPlayers', { roomId: 'REORDER_ROOM', newPlayers: [{ name: 'Bob' }, { name: 'Alice' }] });
            }, testDelay(200));
          });
        });
      });

      s1.on('gameState', (state) => {
        if (!state.players || state.players.length < 2) return;
        if (state.players.length !== 2) {
          clearTimeout(timeoutId);
          cleanup();
          reject(new Error('Server accepted a reorder of the wrong length'));
        } else if (state.players[0].name === 'Bob') {
          clearTimeout(timeoutId);
          cleanup();
          resolve();
        }
      });
    });
  }, 10000);

  it('accepts turnDuration=0 and reconnectTimeout=0 to disable timers', () => {
    return new Promise<void>((resolve, reject) => {
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

  const playingPair = async (roomId: string) => {
    const host = io(`http://127.0.0.1:${PORT}`);
    const guest = io(`http://127.0.0.1:${PORT}`);
    await joinTestRoom(host, roomId, 'Alice', { randomOrder: false, turnDuration: 0, initialCards: { '200': 8 } });
    await joinTestRoom(guest, roomId, 'Bob');
    await acceptOnlineAction(host, roomId, { type: 'start' });
    return { host, guest, cleanup: () => { host.disconnect(); guest.disconnect(); } };
  };

  it('reorderPlayers is blocked when the game is already playing', async () => {
    const roomId = 'REORDER_MIDGAME';
    const { host, cleanup } = await playingPair(roomId);
    try {
      host.emit('reorderPlayers', { roomId, newPlayers: [{ name: 'Bob' }, { name: 'Alice' }] });
      const state = await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false });
      expect(state.players?.map(player => player.name)).toEqual(['Alice', 'Bob']);
      expect(state.currentPlayerIndex).toBe(1);
    } finally { cleanup(); }
  });

  it('updateConfig is blocked when the game is already playing', async () => {
    const roomId = 'UPDATECONFIG_MIDGAME';
    const { host, cleanup } = await playingPair(roomId);
    try {
      host.emit('updateConfig', { roomId, winningScore: 1000 });
      const state = await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false });
      expect(state.winningScore).toBe(6000);
      expect(state.currentPlayerIndex).toBe(1);
    } finally { cleanup(); }
  });

  it('ruleset is applied in the lobby and cannot change through either midgame path', async () => {
    const roomId = 'RULESET_MIDGAME';
    const host = io(`http://127.0.0.1:${PORT}`);
    const guest = io(`http://127.0.0.1:${PORT}`);
    try {
      await joinTestRoom(host, roomId, 'Alice', { randomOrder: false, turnDuration: 0, initialCards: { '200': 8 } });
      await joinTestRoom(guest, roomId, 'Bob');
      expect((await configureTestRoom(host, roomId, { ruleset: 'classic' })).ruleset).toBe('classic');
      await acceptOnlineAction(host, roomId, { type: 'start' });
      host.emit('updateConfig', { roomId, ruleset: 'modernized' });
      const state = await acceptOnlineAction(host, roomId, {
        type: 'commit', score: 100, success: true, summary: {
          cards: [{ card: '200', completed: false }], ended: 'banked', tuttoCount: 0, plusMinusScores: [],
          outcomes: [{ card: '200', scoreBefore: 0, scoreAfter: 100, tuttos: 0 }],
        },
      }, { ruleset: 'modernized' });
      expect(state.ruleset).toBe('classic');
      expect(state.currentPlayerIndex).toBe(1);
    } finally { host.disconnect(); guest.disconnect(); }
  });

  it('rejects updateConfig with invalid initialCards (unknown type, negative count, non-integer, over limit)', () => {
    return new Promise<void>((resolve, reject) => {
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
        // Annotated (rather than inferred from `state`, which is contextually
        // `any` off an untyped socket listener): Object.values/keys on a bare
        // `any` infers its generic to `unknown` under this tsconfig, and the
        // relational checks below need real numbers.
        const cards: Record<string, number> = state.initialCards;
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
    return new Promise<void>((resolve, reject) => {
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
        const cards: Record<string, number> = state.initialCards;
        const total = Object.values(cards).reduce((sum, v) => sum + v, 0);
        expect(total).toBeGreaterThan(0);
        clearTimeout(timeoutId);
        s1.disconnect();
        resolve();
      });
    });
  }, 10000);

  it('reorderPlayers with a non-array newPlayers payload is ignored without crashing', () => {
    return new Promise<void>((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob
      const cleanup = () => { s1.disconnect(); s2.disconnect(); };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Server never applied the valid follow-up reorder'));
      }, 3000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'REORDER_NONARRAY', name: 'Alice', deviceId: 'dev-rna-a', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'REORDER_NONARRAY', name: 'Bob', deviceId: 'dev-rna-b', color: '#00ff00' }, () => {
            // newPlayers is an object, not an array — must be ignored, not throw.
            s1.emit('reorderPlayers', { roomId: 'REORDER_NONARRAY', newPlayers: { foo: 'bar' } });
            // "Without crashing" is only meaningful if something afterwards
            // still works, so a legitimate reorder follows and ends the test.
            setTimeout(() => {
              s1.emit('reorderPlayers', { roomId: 'REORDER_NONARRAY', newPlayers: [{ name: 'Bob' }, { name: 'Alice' }] });
            }, testDelay(200));
          });
        });
      });

      s1.on('gameState', (state) => {
        if (!state.players || state.players.length < 2) return;
        // The two real players must remain intact.
        if (state.players.length !== 2) {
          clearTimeout(timeoutId);
          cleanup();
          reject(new Error('reorderPlayers with non-array payload altered the player list'));
        } else if (state.players[0].name === 'Bob') {
          clearTimeout(timeoutId);
          cleanup();
          resolve();
        }
      });
    });
  }, 10000);

  it('accepts updateConfig with a fully valid initialCards configuration', () => {
    return new Promise<void>((resolve, reject) => {
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

  // Registered last: if the server does die, the failure is unambiguous rather
  // than cascading into every test declared after it.
  it('survives a reorderPlayers array whose entries are not objects', async () => {
    // `Array.isArray` was checked but the ENTRIES were not, so `.map(p => p.name)`
    // threw on a null entry. socket.io dispatches listeners inside
    // process.nextTick, and index.ts installs no uncaughtException handler, so
    // that throw terminated the whole process — every room, every player, from
    // any client that happens to host a room (i.e. anyone who creates one).
    const s1 = io(`http://127.0.0.1:${PORT}`);
    const s2 = io(`http://127.0.0.1:${PORT}`);

    try {
      // Both sockets start connecting at construction, but only s1's listener
      // is attached before the first await yields. If s2 won the race its
      // 'connect' fired into no listener at all, and the second wait below
      // never settled — the test hung to its 15s timeout, which reads as the
      // server having died rather than as a race in the test. Checking
      // .connected first is what closes it; `once` keeps the listener from
      // outliving the wait on a reconnect.
      await connected(s1);
      await connected(s2);
      await new Promise<void>(resolve => s1.emit('joinRoom', { roomId: 'REORDER_HOSTILE', name: 'Alice', deviceId: 'dev-rh-a' }, () => resolve()));
      await new Promise<void>(resolve => s2.emit('joinRoom', { roomId: 'REORDER_HOSTILE', name: 'Bob', deviceId: 'dev-rh-b' }, () => resolve()));

      // Right length, right shape at the array level — garbage inside.
      s1.emit('reorderPlayers', { roomId: 'REORDER_HOSTILE', newPlayers: [null, null] });
      s1.emit('reorderPlayers', { roomId: 'REORDER_HOSTILE', newPlayers: [undefined, { name: 'Bob' }] });
      s1.emit('reorderPlayers', { roomId: 'REORDER_HOSTILE', newPlayers: [42, 'Bob'] });

      await new Promise(resolve => setTimeout(resolve, testDelay(1000)));
      expect(nonNull(serverProcess).exitCode).toBeNull();

      // Still serving: a legitimate reorder after the hostile ones still applies,
      // and the roster the malformed pushes targeted is untouched.
      const reordered = new Promise<string[]>((resolve) => {
        s1.on('gameState', (state) => {
          if (state.players?.length === 2 && state.players[0].name === 'Bob') {
            resolve(state.players.map((p: { name: string }) => p.name));
          }
        });
      });
      s1.emit('reorderPlayers', { roomId: 'REORDER_HOSTILE', newPlayers: [{ name: 'Bob' }, { name: 'Alice' }] });
      expect(await reordered).toEqual(['Bob', 'Alice']);
    } finally {
      // In a finally so a failed assertion above still closes both sockets —
      // a live client keeps the spawned server's event loop busy, and this is
      // the last test in the file.
      s1.disconnect();
      s2.disconnect();
    }
  }, 15000);
});
