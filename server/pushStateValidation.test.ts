/**
 * @vitest-environment node
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Socket as ClientSocket } from 'socket.io-client';
import { startTestServer, makeServerPlayer, makeFakeIo, makeFakeSocket, type JoinAck } from './socketTestHarness';
import { protocolClient, acceptOnlineAction, configureTestRoom, requestPublicState } from './onlineTestClient';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import type { GameStore } from '../src/store/storeTypes';
import { MAX_PLAYERS_PER_ROOM, createRoom, rooms, deleteRoom, emitRoomState } from './rooms';
import { registerGameStateHandlers } from './socketGameStateHandlers';
import { MAX_DECK_SIZE } from './pushValidation';
import { MAX_PUSHED_STATE_BYTES } from './socketLimits';
import type { RoomState } from './roomTypes';
import { MAX_CHAIN_CARDS, MAX_HISTORY_LOG_SIZE, type CardType, type HistoryEntry } from '../src/types';
import { VALID_CARD_TYPES, MIN_ENABLED_TURN_DURATION } from '../src/utils/configValidation';

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

  const clients: ClientSocket[] = [];
  afterEach(() => { clients.splice(0).forEach(socket => socket.disconnect()); });

  const joinRoom = async (roomId: string, name: string, deviceId: string): Promise<ClientSocket> => {
    const socket = protocolClient(`http://127.0.0.1:${PORT}`);
    clients.push(socket);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const ack = await new Promise<JoinAck>(resolve => socket.emit('joinRoom', { roomId, name, deviceId }, resolve));
    expect(ack.success).toBe(true);
    return socket;
  };

  const waitForState = (socket: ClientSocket, predicate: (state: GameStatePayload) => boolean) =>
    new Promise<GameStatePayload>(resolve => {
      const listener = (state: GameStatePayload) => {
        if (!predicate(state)) return;
        socket.off('gameState', listener);
        resolve(state);
      };
      socket.on('gameState', listener);
    });

  const startGame = async (socket: ClientSocket, roomId: string, turnDuration = 0) => {
    await configureTestRoom(socket, roomId, { randomOrder: false, turnDuration, initialCards: { '200': 5 } });
    return acceptOnlineAction(socket, roomId, { type: 'start' });
  };

  it('ignores an out-of-range currentPlayerIndex and keeps the server-side timer alive', async () => {
    const roomId = 'DOS_INDEX_ROOM';
    const alice = await joinRoom(roomId, 'Alice', 'dev-dos-a');
    await joinRoom(roomId, 'Bob', 'dev-dos-b');
    await startGame(alice, roomId, MIN_ENABLED_TURN_DURATION);
    const next = waitForState(alice, state => state.currentPlayerIndex === 1);
    const ack = await new Promise(resolve => alice.emit('pushState', {
      roomId, newState: { currentPlayerIndex: 5000 },
    }, resolve));
    expect(ack).toEqual({ ok: false, reason: 'refused' });
    const state = await next;
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.players?.[0].totalTurns).toBe(1);
  });

  it('ignores malformed chart fields while honest turns keep advancing', async () => {
    const roomId = 'DOS_CHART_ROOM';
    const alice = await joinRoom(roomId, 'Alice', 'dev-chart-a');
    const bob = await joinRoom(roomId, 'Bob', 'dev-chart-b');
    await startGame(alice, roomId);
    const ack = await new Promise(resolve => alice.emit('pushState', {
      roomId, newState: { chartValues: { hacked: true }, chartLabels: 'not-an-array' },
    }, resolve));
    expect(ack).toEqual({ ok: false, reason: 'refused' });
    const SCORE = 100;
    await acceptOnlineAction(alice, roomId, { type: 'commit', score: SCORE, success: true });
    const state = await acceptOnlineAction(bob, roomId, { type: 'commit', score: SCORE, success: true });
    expect(state.round).toBe(2);
    expect(state.chartValues).toEqual([[SCORE], [SCORE]]);
    expect(state.chartLabels).toEqual([1]);
  });

  it('never exposes device IDs or private deck order on a broadcast', async () => {
    const roomId = 'HIJACK_ROOM';
    const alice = await joinRoom(roomId, 'Alice', 'dev-hijack-a');
    const bob = await joinRoom(roomId, 'Bob', 'dev-hijack-b');
    await startGame(alice, roomId);
    const state = await requestPublicState(bob, roomId);
    expect(state.players).toHaveLength(2);
    for (const player of state.players ?? []) expect(player).not.toHaveProperty('deviceId');
    for (const player of state.previousLeaders ?? []) expect(player).not.toHaveProperty('deviceId');
    expect(state).not.toHaveProperty('cards');
  });

  it('does not carry an aborted game clock into the next game in the same room', async () => {
    const roomId = 'ABORT_CLOCK_ROOM';
    const alice = await joinRoom(roomId, 'Alice', 'dev-ac-a');
    const bob = await joinRoom(roomId, 'Bob', 'dev-ac-b');
    await startGame(alice, roomId);
    const ELAPSED_SAMPLE_MS = 1100;
    await new Promise(resolve => setTimeout(resolve, ELAPSED_SAMPLE_MS));
    expect((await requestPublicState(alice, roomId)).gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    const aborted = waitForState(alice, state => state.status === 'lobby' && state.players?.length === 1);
    bob.emit('leaveRoom');
    await aborted;
    await joinRoom(roomId, 'Bob', 'dev-ac-b');
    const restarted = await acceptOnlineAction(alice, roomId, { type: 'start' });
    expect(restarted.gameTimeInSeconds).toBe(0);
  });

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
        const s = protocolClient(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
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
    previousTurnSummary: {
      cards: Array.from({ length: MAX_CHAIN_CARDS }, () => ({ card: '200' as const, completed: true })),
      outcomes: Array.from({ length: MAX_CHAIN_CARDS }, (_, index) => ({
        card: '200' as const, scoreBefore: index * 500, scoreAfter: (index + 1) * 500, tuttos: 1,
      })),
      tuttoCount: MAX_CHAIN_CARDS, plusMinusScores: [], ended: 'banked',
    },
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

  it('measures public-state fanout and performs no broadcast for rejected no-op snapshots', () => {
    const roomId = 'FANOUT-MEASUREMENT';
    const privateState = buildMaximalRoomState();
    privateState.turnDuration = 0;
    privateState.ruleset = 'modernized';
    privateState.currentCard = '200';
    const host = privateState.players[0].socketId;
    const room = rooms[roomId] = createRoom(host);
    room.state = privateState;
    const fake = makeFakeSocket(host);
    const { io, emit } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId, username: privateState.players[0].name } });
    try {
      emitRoomState(io, roomId);
      const publicBytes = Buffer.byteLength(JSON.stringify(emit.mock.calls[0][1]));
      const privateBytes = Buffer.byteLength(JSON.stringify(privateState));
      expect(publicBytes).toBeLessThan(privateBytes);
      emit.mockClear();
      const ack = vi.fn();
      const started = performance.now();
      fake.handlers.pushState({ roomId, base: room.gameplayToken, mutationId: randomUUID(),
        action: { type: 'commit', score: 0, success: false }, newState: privateState }, ack);
      const actionMs = performance.now() - started;
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      expect(emit.mock.calls.filter(([event]) => event === 'gameState')).toHaveLength(1);
      emit.mockClear();
      const NOOP_ATTEMPTS = 25;
      for (let attempt = 0; attempt < NOOP_ATTEMPTS; attempt++) {
        fake.handlers.pushState({ roomId, base: room.gameplayToken, mutationId: randomUUID(), newState: {} }, vi.fn());
      }
      expect(emit).not.toHaveBeenCalled();
      // Diagnostic timing only: deterministic bytes/emissions gate the test,
      // not host speed or unmeasured socket queues/backpressure.
      console.info('[room fanout]', { privateBytes, publicBytes, recipients: MAX_PLAYERS_PER_ROOM,
        bytesPerBroadcast: publicBytes * MAX_PLAYERS_PER_ROOM, acceptedEmissions: 1, rejectedEmissions: 0, actionMs });
    } finally { deleteRoom(roomId); }
  });
});
