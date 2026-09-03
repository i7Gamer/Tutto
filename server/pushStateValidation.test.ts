/**
 * @vitest-environment node
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { asserting, startTestServer, makeServerPlayer, type JoinAck } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import type { GameStore } from '../src/store/storeTypes';
import { MAX_PLAYERS_PER_ROOM } from './rooms';
import { MAX_DECK_SIZE } from './pushValidation';
import { MAX_PUSHED_STATE_BYTES } from './socketLimits';
import type { RoomState } from './roomTypes';
import { MAX_CHAIN_CARDS, MAX_HISTORY_LOG_SIZE, type CardType, type HistoryEntry } from '../src/types';
import { VALID_CARD_TYPES } from '../src/utils/configValidation';

// The shape of a 'gameState' broadcast, matching how the client itself types
// it (src/store/socketSlice.ts's own 'gameState' handler) — a broadcast only
// ever carries a subset of GameStore, plus the ordering counter that is not
// part of the store itself. Kept local to the .test.ts files that need it
// (rather than in socketTestHarness.ts) because that file — unlike this one —
// is part of tsconfig.server.json's production build, which checks under a
// narrower lib/environment than tsconfig.test.json and cannot resolve
// storeTypes.ts's zustand/immer middleware typing.
type GameStatePayload = Partial<GameStore> & { stateVersion?: number };

// Regression coverage for three related fixes to server/index.ts:
//  1. pushState previously trusted several fields (currentPlayerIndex, chartValues,
//     etc.) with no shape/range validation, which could crash the whole process
//     (every room) when the server-authoritative turn timer later read them.
//  2. gameState broadcasts included every player's deviceId — deviceId is the
//     credential that lets a reconnect take over a seat, so leaking it let any
//     room member hijack any other member's seat (and host role).
//  3. Aborting a game (drops below 2 players) didn't reset the room's elapsed-time
//     clock, so the next game in the same room inherited the old game's runtime.
describe('pushState validation, seat-hijack, and abort-clock fixes', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.pushStateValidation;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT, { env: { API_TOKEN: 'test-token' } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const joinRoom = (roomId: string, name: string, deviceId: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const s = io(`http://127.0.0.1:${PORT}`);
      const timeoutId = setTimeout(() => reject(new Error(`join timed out for ${name}`)), 5000);
      s.on('connect', () => {
        s.emit('joinRoom', { roomId, name, deviceId, color: '#ff0000' }, (res: JoinAck) => {
          clearTimeout(timeoutId);
          if (!res.success) return reject(new Error(res.error));
          resolve(s);
        });
      });
    });

  it('ignores an out-of-range currentPlayerIndex and keeps the server-side turn timer alive afterward', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 15000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'DOS_INDEX_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-dos-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-dos-b');

        let sawValidState = false;
        let sawTimerAdvance = false;

        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
          if (state.currentPlayerIndex === 5000) {
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            reject(new Error('currentPlayerIndex 5000 was accepted — validation regressed'));
            return;
          }
          if (state.status === 'playing' && state.currentPlayerIndex === 0 && !sawValidState) {
            sawValidState = true;
            // A malformed push that should be entirely dropped.
            s1.emit('pushState', { roomId, newState: { currentPlayerIndex: 5000 } });
          }
          // If the process had crashed, no further turn-advance state would ever
          // arrive — reaching a second player's turn proves the timer fired safely.
          if (sawValidState && state.currentPlayerIndex === 1 && !sawTimerAdvance) {
            sawTimerAdvance = true;
            expect(state.currentPlayerIndex).toBe(1);
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            resolve();
          }
        }));

        const players = [
          { name: 'Alice', deviceId: 'dev-dos-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-dos-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0, currentCard: '200', turnDuration: 1 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 17000);

  it('ignores malformed chartValues/chartLabels without crashing or corrupting room state', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'DOS_CHART_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-chart-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-chart-b');

        let pushedBad = false;

        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
          if (state.status === 'playing' && !pushedBad) {
            pushedBad = true;
            s1.emit('pushState', {
              roomId,
              newState: { chartValues: { hacked: true }, chartLabels: 'not-an-array' },
            });
            // Prove liveness with a normal, valid follow-up push.
            setTimeout(() => s1.emit('pushState', { roomId, newState: { round: 2 } }), 200);
          }
          if (state.round === 2) {
            expect(Array.isArray(state.chartValues)).toBe(true);
            expect(Array.isArray(state.chartLabels)).toBe(true);
            clearTimeout(timeoutId);
            s1.disconnect(); s2.disconnect();
            resolve();
          }
        }));

        const players = [
          { name: 'Alice', deviceId: 'dev-chart-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-chart-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', {
          roomId,
          newState: { players, status: 'playing', currentPlayerIndex: 0, chartValues: [[], []], chartNames: ['Alice', 'Bob'] },
        });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 10000);

  it('never includes deviceId on any player in a gameState broadcast', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 8000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'HIJACK_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-hijack-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-hijack-b');

        s2.on('gameState', asserting(reject, (state: GameStatePayload) => {
          if (state.players?.length !== 2) return;
          for (const p of state.players) {
            expect('deviceId' in p).toBe(false);
          }
          if (state.previousLeaders) {
            for (const p of state.previousLeaders) {
              expect('deviceId' in p).toBe(false);
            }
          }
          clearTimeout(timeoutId);
          s1.disconnect(); s2.disconnect();
          resolve();
        }));

        const players = [
          { name: 'Alice', deviceId: 'dev-hijack-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-hijack-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 10000);

  it('does not carry a stale game clock from an aborted game into the next game in the same room', () => {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Test timed out')), 10000);
      let s1: ClientSocket, s2: ClientSocket;

      (async () => {
        const roomId = 'ABORT_CLOCK_ROOM';
        s1 = await joinRoom(roomId, 'Alice', 'dev-ac-a');
        s2 = await joinRoom(roomId, 'Bob', 'dev-ac-b');

        const players = [
          { name: 'Alice', deviceId: 'dev-ac-a', socketId: s1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-ac-b', socketId: s2.id, disconnected: false, score: 0 },
        ];
        s1.emit('pushState', { roomId, newState: { players, status: 'playing', currentPlayerIndex: 0 } });

        // Let the first game's clock accumulate >200ms of runtime before aborting it,
        // so a leaked gameActualStartTime is distinguishable from a fresh one.
        await new Promise((r) => setTimeout(r, 350));

        let restarted = false;
        s1.on('gameState', asserting(reject, (state: GameStatePayload) => {
          if (state.status === 'lobby' && state.players?.length === 1 && !restarted) {
            restarted = true;
            (async () => {
              const s2b = await joinRoom(roomId, 'Bob', 'dev-ac-b');
              const restartPlayers = [
                { name: 'Alice', deviceId: 'dev-ac-a', socketId: s1.id, disconnected: false, score: 0 },
                { name: 'Bob', deviceId: 'dev-ac-b', socketId: s2b.id, disconnected: false, score: 0 },
              ];
              s1.emit('pushState', { roomId, newState: { players: restartPlayers, status: 'playing', currentPlayerIndex: 0 } });

              s1.once('gameState', (freshState) => {
                // Without the fix, this reads >=1 (the old game's accumulated time).
                expect(freshState.gameTimeInSeconds).toBeLessThan(1);
                clearTimeout(timeoutId);
                s1.disconnect(); s2b.disconnect();
                resolve();
              });
            })().catch((err) => { clearTimeout(timeoutId); reject(err); });
          }
        }));

        s2.emit('leaveRoom');
      })().catch((err) => { clearTimeout(timeoutId); reject(err); });
    });
  }, 12000);

  // Regression coverage for server/index.ts's Server constructor: previously
  // left at the engine.io library default (undocumented, and could change on
  // a socket.io upgrade), maxHttpBufferSize is now an explicit, named
  // constant. This proves it is actually wired up and bounds one incoming
  // packet's raw size BEFORE it ever reaches pushValidation.ts's field
  // checks — a client that ignores the cap gets its connection dropped
  // rather than served.
  describe('maxHttpBufferSize bounds an oversized socket packet', () => {
    const connectRawSocket = (): Promise<ClientSocket> =>
      new Promise((resolve, reject) => {
        const s = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
        const timeoutId = setTimeout(() => reject(new Error('connect timed out')), 5000);
        s.on('connect', () => { clearTimeout(timeoutId); resolve(s); });
      });

    it('drops the connection when a client sends a packet over the configured cap', async () => {
      const sock = await connectRawSocket();
      const disconnectedReason = new Promise<string>(resolve => sock.once('disconnect', resolve));

      // The content doesn't matter — the cap is enforced on the raw packet
      // bytes before any field is ever parsed or validated.
      sock.emit('pushState', { roomId: 'OVERSIZED-PACKET-ROOM', newState: { junk: 'x'.repeat(MAX_PUSHED_STATE_BYTES + 1024) } });

      await disconnectedReason;
      expect(sock.connected).toBe(false);
      sock.close();
    }, 10000);

    it('keeps the connection open for a packet safely under the cap', async () => {
      const sock = await connectRawSocket();
      let disconnected = false;
      sock.on('disconnect', () => { disconnected = true; });

      sock.emit('pushState', { roomId: 'UNDERSIZED-PACKET-ROOM', newState: { junk: 'x'.repeat(1024) } });
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(disconnected).toBe(false);
      expect(sock.connected).toBe(true);
      sock.close();
    }, 10000);
  });
});

// How many rounds a realistically long game can be expected to reach — not
// MAX_ROUNDS (100,000 in pushValidation.ts), which is a pure safety cap far
// beyond anything a human game could reach, but generous headroom over a
// genuinely long session (several times a normal ~20-40 round game) for
// sizing MAX_PUSHED_STATE_BYTES against.
const REALISTIC_MAX_ROUNDS = 400;

// The largest state a real game can legitimately produce: every cap a room
// can hit at once. Mirrors buildGameStatePayload's shape (rooms.ts) closely
// enough for a byte-size measurement — a full roster, a maxed-out history
// log with maximal classic chains, a fully-drawn deck, and chart history out
// to REALISTIC_MAX_ROUNDS.
const buildMaximalRoomState = (): RoomState => {
  const players = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, i) =>
    makeServerPlayer(`Player-${i}-with-a-realistically-long-display-name`, {
      position: i,
      deviceId: `device-${i}-${'x'.repeat(40)}`,
      socketId: `socket-${i}-${'x'.repeat(20)}`,
      color: '#a1b2c3',
    }));

  const maximalChain: CardType[] = Array.from(
    { length: MAX_CHAIN_CARDS },
    (_, i) => VALID_CARD_TYPES[i % VALID_CARD_TYPES.length],
  );
  const maximalDeductedPlayers = Array.from(
    { length: MAX_CHAIN_CARDS },
    (_, i) => players[i % players.length].name,
  );
  const maximalDeductedAmounts = Array.from({ length: MAX_CHAIN_CARDS }, () => 1000);

  const historyLog: HistoryEntry[] = Array.from({ length: MAX_HISTORY_LOG_SIZE }, (_, i) => ({
    id: `history-entry-${i}-${'x'.repeat(20)}`,
    round: i + 1,
    playerName: players[i % players.length].name,
    playerColor: '#a1b2c3',
    card: 'Kniffel',
    type: 'success',
    score: 30000,
    deductedPlayers: maximalDeductedPlayers,
    deductedAmounts: maximalDeductedAmounts,
    cards: maximalChain,
  }));

  const cards: CardType[] = Array.from(
    { length: MAX_DECK_SIZE },
    (_, i) => VALID_CARD_TYPES[i % VALID_CARD_TYPES.length],
  );

  return {
    players,
    status: 'playing',
    initialCards: {},
    winningScore: 30000,
    randomOrder: true,
    turnDuration: 60,
    reconnectTimeout: 60,
    currentCard: 'Kniffel',
    cards,
    round: REALISTIC_MAX_ROUNDS,
    currentPlayerIndex: 0,
    finished: false,
    chartValues: players.map(() => Array.from({ length: REALISTIC_MAX_ROUNDS }, () => 999999)),
    chartNames: players.map(p => p.name),
    chartLabels: Array.from({ length: REALISTIC_MAX_ROUNDS }, (_, i) => i + 1),
    gameTimeInSeconds: 999999,
    turnStartTime: Date.now(),
    previousCard: 'Kniffel',
    previousScore: 30000,
    previousLeaders: null,
    previousWasBust: false,
    previousWasSuccess: true,
    previousHighestTurnScore: 30000,
    previousHighestFeuerwerkTurnScore: 30000,
    previousHighestX2TurnScore: 30000,
    previousPlayerName: players[0].name,
    previousTurnSummary: null,
    liveTurnState: null,
    enforcedDiceMode: null,
    ruleset: 'classic',
    historyLog,
  };
};

// Regression coverage for MAX_PUSHED_STATE_BYTES (server/socketLimits.ts):
// the cap must actually fit the largest state a real game can produce.
// Previously it did not — the old 512 KiB cap sat below a maximal state built
// the same way this test builds one — so a room that ever reached that size
// would have every gameState broadcast dropped by socket.io's own
// oversize-packet handling, making the room unplayable rather than merely
// slow.
describe('maximal pushed/broadcast state size', () => {
  it('stays comfortably under MAX_PUSHED_STATE_BYTES with headroom', () => {
    const state = buildMaximalRoomState();
    const byteLength = Buffer.byteLength(JSON.stringify(state));

    expect(byteLength).toBeLessThan(MAX_PUSHED_STATE_BYTES);
    // Real headroom, not a near-miss: a genuinely maximal state should sit
    // well below the cap, not creep up on it.
    expect(byteLength).toBeLessThan(MAX_PUSHED_STATE_BYTES * 0.75);
  });
});
