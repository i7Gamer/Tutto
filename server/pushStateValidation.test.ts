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
import { SERVER_STARTUP_HOOK_TIMEOUT_MS } from './testTimeouts';
import type { GameStore } from '../src/store/storeTypes';
import { MAX_PLAYERS_PER_ROOM, createRoom, rooms, deleteRoom, emitRoomState, sanitizePlayerForBroadcast } from './rooms';
import { registerGameStateHandlers } from './socketGameStateHandlers';
import { MAX_DECK_SIZE, MAX_PLAYER_NAME_LENGTH, MAX_ROOM_ID_LENGTH, MAX_SCORE_MAGNITUDE } from '../src/utils/configValidation';
import { MAX_PUSHED_STATE_BYTES } from './socketLimits';
import type { RoomState, ServerPlayer } from './roomTypes';
import { MAX_CHAIN_CARDS, MAX_HISTORY_LOG_SIZE, type CardType, type HistoryEntry, type TurnSummary } from '../src/types';
import { VALID_CARD_TYPES, MIN_ENABLED_TURN_DURATION } from '../src/utils/configValidation';
import { PLAYER_RECORD_FIELDS } from '../src/utils/playerStats';
import { isValidTurnSummary } from './turnPayloadValidation';
import { applyOnlineGameAction } from './gameActionAuthority';
import { PLUS_MINUS_SCORE } from '../src/utils/coreGameEngine';

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
  }, SERVER_STARTUP_HOOK_TIMEOUT_MS);

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
  // packet's raw size BEFORE the application handler reads any payload fields
  // — a client that ignores the cap gets its connection dropped rather than
  // served.
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

// A deterministic, deliberately representative long-game fixture for byte-size
// accounting. It is not a mathematical maximum: production chart retention is
// separately capped, and cached/rolled-back v2 clients may still send historical
// full `newState` envelopes while current clients send `newState: {}`.
const REPRESENTATIVE_LONG_GAME_ROUNDS = 400;
const REPRESENTATIVE_DEVICE_ID_PAD = 40;
const REPRESENTATIVE_SOCKET_ID_PAD = 20;
const REPRESENTATIVE_HISTORY_ID_PAD = 20;
const REPRESENTATIVE_DEDUCTION_AMOUNT = 1000;
const REPRESENTATIVE_TURN_SECONDS = 60;
const ORDINARY_COMMIT_SCORE = 0;
const DISABLED_TURN_DURATION = 0;
const SOCKET_IO_EVENT_PREFIX = '42';
const PUSH_STATE_EVENT = 'pushState';
const EMPTY_ENVELOPE_MIN_SAVINGS_BYTES = 100_000;
const EMPTY_ENVELOPE_MIN_SAVINGS_RATIO = 1_000;
const FULL_BOUNDED_ACTION_CAP_DIVISOR = 10;
const CLASSIC_SUMMARY_CARD: CardType = '200';
const CLASSIC_SUMMARY_CARD_SCORE = 200;
const PLUS_MINUS_CARD: CardType = 'Plus_Minus';
const MULTIBYTE_NAME_CHAR = '界';
const TOKEN_BASE = '11111111-1111-4111-8111-111111111111';
const TOKEN_MUTATION = '22222222-2222-4222-8222-222222222222';

const boundedPlayerName = (index: number): string =>
  `Player-${String(index).padStart(3, '0')}`.slice(0, MAX_PLAYER_NAME_LENGTH);

const boundedMultibytePlayerName = (suffix: string): string =>
  `${MULTIBYTE_NAME_CHAR.repeat(MAX_PLAYER_NAME_LENGTH - suffix.length)}${suffix}`;

const boundedRoomId = (): string => 'R'.repeat(MAX_ROOM_ID_LENGTH);

const framedSocketEventBytes = (event: string, payload: unknown): number =>
  Buffer.byteLength(`${SOCKET_IO_EVENT_PREFIX}${JSON.stringify([event, payload])}`, 'utf8');

const buildFullLengthNumericClassicSummary = (): TurnSummary => ({
  cards: Array.from({ length: MAX_CHAIN_CARDS }, () => ({ card: CLASSIC_SUMMARY_CARD, completed: true })),
  outcomes: Array.from({ length: MAX_CHAIN_CARDS }, (_, index) => ({
    card: CLASSIC_SUMMARY_CARD,
    scoreBefore: index * CLASSIC_SUMMARY_CARD_SCORE,
    scoreAfter: (index + 1) * CLASSIC_SUMMARY_CARD_SCORE,
    tuttos: 1,
  })),
  tuttoCount: MAX_CHAIN_CARDS,
  plusMinusScores: [],
  ended: 'banked',
});

const buildFullBoundedPlusMinusSummary = (ended: 'banked' | 'null'): TurnSummary => {
  const finalScore = MAX_CHAIN_CARDS * PLUS_MINUS_SCORE;
  const deductedPlayer = boundedMultibytePlayerName('B');
  return {
    cards: Array.from({ length: MAX_CHAIN_CARDS }, () => ({ card: PLUS_MINUS_CARD, completed: true })),
    outcomes: Array.from({ length: MAX_CHAIN_CARDS }, (_, index) => ({
      card: PLUS_MINUS_CARD,
      scoreBefore: index * PLUS_MINUS_SCORE,
      scoreAfter: (index + 1) * PLUS_MINUS_SCORE,
      tuttos: 1,
    })),
    tuttoCount: MAX_CHAIN_CARDS,
    plusMinusScores: Array.from({ length: MAX_CHAIN_CARDS }, (_, index) => index * PLUS_MINUS_SCORE),
    ended,
    ...(ended === 'null' ? { forfeitedScore: finalScore } : {}),
    deductedPlayers: Array.from({ length: MAX_CHAIN_CARDS }, () => deductedPlayer),
    deductedAmounts: Array.from({ length: MAX_CHAIN_CARDS }, () => PLUS_MINUS_SCORE),
    prevMostCardsInTurn: MAX_CHAIN_CARDS,
    prevHighestForfeitedTurnScore: MAX_SCORE_MAGNITUDE,
  };
};

const createClassicPlusMinusActionRoom = (socketId: string) => {
  const room = createRoom(socketId);
  room.state.status = 'playing';
  room.state.ruleset = 'classic';
  room.state.winningScore = MAX_SCORE_MAGNITUDE;
  room.state.players = [
    makeServerPlayer(boundedMultibytePlayerName('A'), { socketId, score: 0, position: 0 }),
    makeServerPlayer(boundedMultibytePlayerName('B'), { socketId: `${socketId}-peer`, score: MAX_SCORE_MAGNITUDE, position: 1 }),
  ];
  room.state.currentPlayerIndex = 0;
  room.state.currentCard = PLUS_MINUS_CARD;
  room.dealtThisTurn = Array.from({ length: MAX_CHAIN_CARDS }, () => PLUS_MINUS_CARD);
  return room;
};

const playerForLegacyEnvelope = (player: ServerPlayer): Record<string, unknown> => {
  const dto = { ...sanitizePlayerForBroadcast(player) } as Record<string, unknown>;
  for (const field of PLAYER_RECORD_FIELDS) {
    if (dto[field] === undefined) dto[field] = null;
  }
  return dto;
};

const buildRepresentativeRoomState = (): RoomState => {
  const players = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, i) =>
    makeServerPlayer(boundedPlayerName(i), {
      position: i,
      deviceId: `device-${i}-${'x'.repeat(REPRESENTATIVE_DEVICE_ID_PAD)}`,
      socketId: `socket-${i}-${'x'.repeat(REPRESENTATIVE_SOCKET_ID_PAD)}`,
      color: '#a1b2c3',
    }));

  const representativeChain: CardType[] = Array.from(
    { length: MAX_CHAIN_CARDS },
    (_, i) => VALID_CARD_TYPES[i % VALID_CARD_TYPES.length],
  );
  const representativeDeductedPlayers = Array.from(
    { length: MAX_CHAIN_CARDS },
    (_, i) => players[i % players.length].name,
  );
  const representativeDeductedAmounts = Array.from({ length: MAX_CHAIN_CARDS }, () => REPRESENTATIVE_DEDUCTION_AMOUNT);

  const historyLog: HistoryEntry[] = Array.from({ length: MAX_HISTORY_LOG_SIZE }, (_, i) => ({
    id: `history-entry-${i}-${'x'.repeat(REPRESENTATIVE_HISTORY_ID_PAD)}`,
    round: i + 1,
    playerName: players[i % players.length].name,
    playerColor: '#a1b2c3',
    card: 'Kniffel',
    type: 'success',
    score: MAX_SCORE_MAGNITUDE,
    deductedPlayers: representativeDeductedPlayers,
    deductedAmounts: representativeDeductedAmounts,
    cards: representativeChain,
  }));

  const cards: CardType[] = Array.from(
    { length: MAX_DECK_SIZE },
    (_, i) => VALID_CARD_TYPES[i % VALID_CARD_TYPES.length],
  );

  return {
    players,
    status: 'playing',
    initialCards: {},
    winningScore: MAX_SCORE_MAGNITUDE,
    randomOrder: true,
    turnDuration: REPRESENTATIVE_TURN_SECONDS,
    reconnectTimeout: REPRESENTATIVE_TURN_SECONDS,
    currentCard: 'Kniffel',
    cards,
    round: REPRESENTATIVE_LONG_GAME_ROUNDS,
    currentPlayerIndex: 0,
    finished: false,
    chartValues: players.map(() => Array.from({ length: REPRESENTATIVE_LONG_GAME_ROUNDS }, () => MAX_SCORE_MAGNITUDE)),
    chartNames: players.map(p => p.name),
    chartLabels: Array.from({ length: REPRESENTATIVE_LONG_GAME_ROUNDS }, (_, i) => i + 1),
    gameTimeInSeconds: MAX_SCORE_MAGNITUDE,
    turnStartTime: Date.now(),
    previousCard: 'Kniffel',
    previousScore: MAX_SCORE_MAGNITUDE,
    previousLeaders: null,
    previousWasBust: false,
    previousWasSuccess: true,
    previousHighestTurnScore: MAX_SCORE_MAGNITUDE,
    previousHighestFeuerwerkTurnScore: MAX_SCORE_MAGNITUDE,
    previousHighestX2TurnScore: MAX_SCORE_MAGNITUDE,
    previousPlayerName: players[0].name,
    previousTurnSummary: buildFullLengthNumericClassicSummary(),
    liveTurnState: null,
    enforcedDiceMode: null,
    ruleset: 'classic',
    historyLog,
  };
};

const buildLegacyNewState = (state: RoomState): Record<string, unknown> => ({
  players: state.players.map(playerForLegacyEnvelope),
  currentPlayerIndex: state.currentPlayerIndex,
  currentCard: state.currentCard,
  round: state.round,
  winningScore: state.winningScore,
  initialCards: state.initialCards,
  randomOrder: state.randomOrder,
  turnDuration: state.turnDuration,
  reconnectTimeout: state.reconnectTimeout,
  finished: state.finished,
  gameTimeInSeconds: state.gameTimeInSeconds,
  previousScore: state.previousScore,
  previousCard: state.previousCard,
  previousLeaders: state.previousLeaders?.map(playerForLegacyEnvelope) ?? null,
  previousWasBust: state.previousWasBust,
  previousWasSuccess: state.previousWasSuccess ?? null,
  previousHighestTurnScore: state.previousHighestTurnScore,
  previousHighestFeuerwerkTurnScore: state.previousHighestFeuerwerkTurnScore,
  previousHighestX2TurnScore: state.previousHighestX2TurnScore,
  previousPlayerName: state.previousPlayerName,
  previousTurnSummary: state.previousTurnSummary,
  chartValues: state.chartValues,
  chartNames: state.chartNames,
  chartLabels: state.chartLabels,
  status: state.status,
  liveTurnState: state.liveTurnState,
  enforcedDiceMode: state.enforcedDiceMode,
  ruleset: state.ruleset,
  historyLog: state.historyLog,
});

const legacyPushEnvelope = (state = buildRepresentativeRoomState()) => ({
  roomId: boundedRoomId(),
  base: TOKEN_BASE,
  mutationId: TOKEN_MUTATION,
  action: { type: 'commit', score: ORDINARY_COMMIT_SCORE, success: false },
  newState: buildLegacyNewState(state),
});

const currentPushEnvelope = (action: Record<string, unknown> = { type: 'commit', score: ORDINARY_COMMIT_SCORE, success: false }) => ({
  roomId: boundedRoomId(),
  base: TOKEN_BASE,
  mutationId: TOKEN_MUTATION,
  action,
  newState: {},
});

// Regression coverage for MAX_PUSHED_STATE_BYTES (server/socketLimits.ts): the
// incoming cap must stay above representative legacy v2 client envelopes and
// current bounded action packets. Outgoing gameState broadcasts are measured as
// fanout cost only; this cap does not govern packets the server sends.
describe('representative push packet size and broadcast fanout', () => {
  it('keeps a representative legacy v2 full-envelope push below the unchanged incoming cap', () => {
    const bytes = framedSocketEventBytes(PUSH_STATE_EVENT, legacyPushEnvelope());

    expect(bytes).toBeLessThan(MAX_PUSHED_STATE_BYTES);
    console.info('[representative legacy pushState bytes]', { bytes, cap: MAX_PUSHED_STATE_BYTES });
  });

  it('quantifies the deterministic savings from the current empty-envelope push', () => {
    const legacyBytes = framedSocketEventBytes(PUSH_STATE_EVENT, legacyPushEnvelope());
    const currentBytes = framedSocketEventBytes(PUSH_STATE_EVENT, currentPushEnvelope());

    expect(legacyBytes - currentBytes).toBeGreaterThan(EMPTY_ENVELOPE_MIN_SAVINGS_BYTES);
    expect(legacyBytes / currentBytes).toBeGreaterThan(EMPTY_ENVELOPE_MIN_SAVINGS_RATIO);
    expect(currentBytes).toBeLessThan(MAX_PUSHED_STATE_BYTES);
    console.info('[pushState empty-envelope savings]', { legacyBytes, currentBytes, savedBytes: legacyBytes - currentBytes });
  });

  it('keeps a full-length numeric classic commit action far below the incoming cap', () => {
    // This is a deliberately dense valid current command, not a mathematical
    // maximum: Plus/Minus chains and failed turns can add summary metadata that
    // this numeric success path does not exercise.
    const summary = buildFullLengthNumericClassicSummary();
    expect(isValidTurnSummary(summary)).toBe(true);
    const action = {
      type: 'commit', score: MAX_CHAIN_CARDS * CLASSIC_SUMMARY_CARD_SCORE, success: true, summary,
    };
    const room = createRoom('classic-action-socket');
    room.state.status = 'playing';
    room.state.ruleset = 'classic';
    room.state.players = [
      makeServerPlayer('Alice', { socketId: 'classic-action-socket' }),
      makeServerPlayer('Bob', { socketId: 'classic-action-peer' }),
    ];
    room.state.currentPlayerIndex = 0;
    room.state.currentCard = CLASSIC_SUMMARY_CARD;
    room.dealtThisTurn = Array.from({ length: MAX_CHAIN_CARDS }, () => CLASSIC_SUMMARY_CARD);
    expect(applyOnlineGameAction(room, action, 'classic-action-socket')).toBe(true);

    const bytes = framedSocketEventBytes(PUSH_STATE_EVENT, currentPushEnvelope(action));
    expect(bytes).toBeLessThan(MAX_PUSHED_STATE_BYTES / FULL_BOUNDED_ACTION_CAP_DIVISOR);
    console.info('[full-length numeric classic pushState bytes]', { bytes, cap: MAX_PUSHED_STATE_BYTES });
  });

  it('keeps a full bounded Plus/Minus success action below the incoming cap', () => {
    const summary = buildFullBoundedPlusMinusSummary('banked');
    expect(isValidTurnSummary(summary)).toBe(true);
    const action = {
      type: 'commit', score: MAX_CHAIN_CARDS * PLUS_MINUS_SCORE, success: true, summary,
    };
    const room = createClassicPlusMinusActionRoom('plus-minus-success-socket');
    expect(applyOnlineGameAction(room, action, 'plus-minus-success-socket')).toBe(true);

    const bytes = framedSocketEventBytes(PUSH_STATE_EVENT, currentPushEnvelope(action));
    expect(bytes).toBeLessThan(MAX_PUSHED_STATE_BYTES / FULL_BOUNDED_ACTION_CAP_DIVISOR);
    console.info('[full bounded plus-minus success pushState bytes]', { bytes, cap: MAX_PUSHED_STATE_BYTES });
  });

  it('keeps a full bounded Plus/Minus null-ending action below the incoming cap', () => {
    const summary = buildFullBoundedPlusMinusSummary('null');
    expect(isValidTurnSummary(summary)).toBe(true);
    const action = {
      type: 'commit', score: ORDINARY_COMMIT_SCORE, success: false, summary,
    };
    const room = createClassicPlusMinusActionRoom('plus-minus-null-socket');
    expect(applyOnlineGameAction(room, action, 'plus-minus-null-socket')).toBe(true);

    const bytes = framedSocketEventBytes(PUSH_STATE_EVENT, currentPushEnvelope(action));
    expect(bytes).toBeLessThan(MAX_PUSHED_STATE_BYTES / FULL_BOUNDED_ACTION_CAP_DIVISOR);
    console.info('[full bounded plus-minus null pushState bytes]', { bytes, cap: MAX_PUSHED_STATE_BYTES });
  });

  it('measures public-state fanout and performs no broadcast for rejected no-op actions', () => {
    const roomId = 'FANOUT-MEASUREMENT';
    const privateState = buildRepresentativeRoomState();
    privateState.turnDuration = DISABLED_TURN_DURATION;
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
      const publicBytes = Buffer.byteLength(JSON.stringify(emit.mock.calls[0][1]), 'utf8');
      const privateBytes = Buffer.byteLength(JSON.stringify(privateState), 'utf8');
      expect(publicBytes).toBeLessThan(privateBytes);
      emit.mockClear();
      const ack = vi.fn();
      const started = performance.now();
      fake.handlers.pushState({ roomId, base: room.gameplayToken, mutationId: randomUUID(),
        action: { type: 'commit', score: ORDINARY_COMMIT_SCORE, success: false }, newState: buildLegacyNewState(privateState) }, ack);
      const actionMs = performance.now() - started;
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      expect(emit.mock.calls.filter(([event]) => event === 'gameState')).toHaveLength(1);
      emit.mockClear();
      const NOOP_ATTEMPTS = 25;
      for (let attempt = 0; attempt < NOOP_ATTEMPTS; attempt++) {
        fake.handlers.pushState({ roomId, base: room.gameplayToken, mutationId: randomUUID(), action: { type: 'noop' }, newState: {} }, vi.fn());
      }
      expect(emit).not.toHaveBeenCalled();
      // Diagnostic timing only: deterministic bytes/emissions gate the test,
      // not host speed or unmeasured socket queues/backpressure.
      console.info('[room fanout]', { privateBytes, publicBytes, recipients: MAX_PLAYERS_PER_ROOM,
        bytesPerBroadcast: publicBytes * MAX_PLAYERS_PER_ROOM, acceptedEmissions: 1, rejectedEmissions: 0, actionMs });
    } finally { deleteRoom(roomId); }
  });
});
