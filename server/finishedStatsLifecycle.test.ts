/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { registerStatsHandlers } from './socketStatsHandlers';
import { registerGameStateHandlers } from './socketGameStateHandlers';
import { registerRosterHandlers } from './socketRosterHandlers';
import { advanceTurnOnTimeout } from './turnTimers';
import { makeFakeSocket, makeFakeIo, makeServerPlayer, type Handler } from './socketTestHarness';
import { rooms, createRoom, deleteRoom, emitRoomState } from './rooms';
import type { CardType, OnlineGameAction } from '../src/types';
import { DEFAULT_INITIAL_CARDS } from '../src/utils/configValidation';
import { MS_PER_SECOND } from '../src/utils/time';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(), updateDeviceStats: vi.fn(), updateGlobalStats: vi.fn(),
}));
import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';

const makePlayer = (name: string, socketId: string, deviceId: string) =>
  makeServerPlayer(name, { socketId, deviceId });

const WINNING_SCORE = 1000;
const FORGED_SCORE = 999_999;
const ELAPSED_MS = 12_000;
const NUMERIC_CARD_COUNT = 8;

type FinishRoute = 'commit' | 'timeout' | 'active-removal';
type StatsIngress = 'legacy' | 'reduced';

describe('complete finish snapshots from accepted starts', () => {
  const roomId = 'FINISH-LIFECYCLE-ROOM';
  const legacyIngressCases = [
    { route: 'commit', ingress: 'legacy' },
    { route: 'commit', ingress: 'reduced' },
    { route: 'timeout', ingress: 'legacy' },
    { route: 'timeout', ingress: 'reduced' },
    { route: 'active-removal', ingress: 'legacy' },
    { route: 'active-removal', ingress: 'reduced' },
  ] as const satisfies readonly { route: FinishRoute; ingress: StatsIngress }[];

  const singleNumericDeck = () => {
    const cards = { ...DEFAULT_INITIAL_CARDS };
    for (const card of Object.keys(cards) as CardType[]) cards[card] = 0;
    cards['200'] = NUMERIC_CARD_COUNT;
    return cards;
  };

  let lifecycleIo: ReturnType<typeof makeFakeIo>['io'];
  let lifecycleSockets: Map<string, unknown>;

  const resetLifecycleIo = (): void => {
    const fakeIo = makeFakeIo();
    lifecycleSockets = new Map();
    lifecycleIo = Object.assign(fakeIo.io, { sockets: { sockets: lifecycleSockets } });
  };

  const lifecycleHandlers = (socketId: string, username: string) => {
    const fake = makeFakeSocket(socketId);
    lifecycleSockets.set(socketId, fake.socket);
    const context = { io: lifecycleIo, socket: fake.socket, session: { roomId, username } };
    registerGameStateHandlers(context);
    registerRosterHandlers(context);
    registerStatsHandlers(context);
    return fake.handlers;
  };

  const pushAction = (
    handler: Handler,
    action: OnlineGameAction,
    newState: Record<string, unknown> = {},
  ): void => {
    handler({
      roomId,
      newState,
      base: rooms[roomId].gameplayToken,
      mutationId: randomUUID(),
      action,
    });
  };

  const forgedLegacyNewState = (): Record<string, unknown> => ({
    status: 'playing',
    finished: true,
    gameTimeInSeconds: FORGED_SCORE,
    players: [
      { name: 'Mallory', socketId: 'mallory-sock', deviceId: 'mallory-device', score: FORGED_SCORE },
    ],
    historyLog: [{ id: 'forged', playerName: 'Mallory', round: FORGED_SCORE, card: '200', type: 'success', score: FORGED_SCORE }],
    chartLabels: [FORGED_SCORE],
    chartValues: [[FORGED_SCORE]],
  });

  const resetStatsMocks = (): void => {
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
    vi.mocked(updateGlobalStats).mockReset().mockResolvedValue(1);
  };

  const expectParticipantStats = (expectedDevices: readonly string[]): void => {
    const room = rooms[roomId];
    expect([...(room.participantStats?.keys() ?? [])].sort()).toEqual([...expectedDevices].sort());
    for (const deviceId of expectedDevices) {
      expect(room.participantStats?.get(deviceId)).toEqual(expect.objectContaining({
        deviceId,
        socketId: expect.any(String),
        totalTurns: expect.any(Number),
        score: expect.any(Number),
        busts: expect.any(Number),
      }));
    }
  };

  const expectFrozenFinish = (expectedDevices: readonly string[]): void => {
    const room = rooms[roomId];
    expect(room.finishedGameToken).toBe(room.gameplayToken);
    expect(room.finishedGame).toEqual(expect.objectContaining({
      winners: ['Alice'],
      playerCount: expectedDevices.length,
      round: room.state.round,
      gameTimeInSeconds: expect.any(Number),
      winnerDeviceIds: ['lifecycle-alice-device'],
    }));
    expect(room.finishedGame?.gameTimeInSeconds).toBeGreaterThanOrEqual(ELAPSED_MS / MS_PER_SECOND);
    expect(room.finishedGame?.players?.map(player => player.deviceId).sort()).toEqual([...expectedDevices].sort());
    for (const deviceId of expectedDevices) {
      expect(room.finishedGame?.players?.find(player => player.deviceId === deviceId)).toEqual(expect.objectContaining({
        deviceId,
        socketId: expect.any(String),
        totalTurns: expect.any(Number),
        score: expect.any(Number),
        busts: expect.any(Number),
      }));
    }
  };

  const startAcceptedGame = (includeCarol = false) => {
    rooms[roomId] = createRoom('alice-sock');
    Object.assign(rooms[roomId].state, {
      players: [
        makePlayer('Alice', 'alice-sock', 'lifecycle-alice-device'),
        makePlayer('Bob', 'bob-sock', 'lifecycle-bob-device'),
        ...(includeCarol ? [makePlayer('Carol', 'carol-sock', 'lifecycle-carol-device')] : []),
      ],
      initialCards: singleNumericDeck(),
      randomOrder: false,
      winningScore: WINNING_SCORE,
    });
    const alice = lifecycleHandlers('alice-sock', 'Alice');
    const bob = lifecycleHandlers('bob-sock', 'Bob');
    const carol = includeCarol ? lifecycleHandlers('carol-sock', 'Carol') : null;

    pushAction(alice.pushState as Handler, { type: 'start' }, forgedLegacyNewState());
    expect(rooms[roomId].state.status).toBe('playing');
    expectParticipantStats(includeCarol
      ? ['lifecycle-alice-device', 'lifecycle-bob-device', 'lifecycle-carol-device']
      : ['lifecycle-alice-device', 'lifecycle-bob-device']);
    return { alice, bob, carol };
  };

  const finishByCommit = () => {
    const handlers = startAcceptedGame(false);
    const room = rooms[roomId];
    room.gameActualStartTime = Date.now() - ELAPSED_MS;
    pushAction(handlers.alice.pushState as Handler, { type: 'commit', score: WINNING_SCORE, success: true }, forgedLegacyNewState());
    pushAction(handlers.bob.pushState as Handler, { type: 'commit', score: 0, success: false }, {});
    expect(room.state.finished).toBe(true);
    expectFrozenFinish(['lifecycle-alice-device', 'lifecycle-bob-device']);
    return handlers;
  };

  const finishByTimeout = () => {
    const handlers = startAcceptedGame(false);
    const room = rooms[roomId];
    Object.assign(room.state, {
      currentPlayerIndex: 1,
      currentCard: '200',
      cards: [],
      players: [
        { ...room.state.players[0], score: WINNING_SCORE },
        { ...room.state.players[1], score: 0 },
      ],
    });
    room.gameActualStartTime = Date.now() - ELAPSED_MS;
    advanceTurnOnTimeout(lifecycleIo, roomId);
    expect(room.state.finished).toBe(true);
    expectFrozenFinish(['lifecycle-alice-device', 'lifecycle-bob-device']);
    return handlers;
  };

  const finishByActiveRemoval = () => {
    const handlers = startAcceptedGame(true);
    const room = rooms[roomId];
    Object.assign(room.state, {
      currentPlayerIndex: 2,
      currentCard: '200',
      cards: [],
      players: [
        { ...room.state.players[0], score: WINNING_SCORE },
        { ...room.state.players[1], score: 0 },
        { ...room.state.players[2], score: 0 },
      ],
    });
    room.gameActualStartTime = Date.now() - ELAPSED_MS;
    (handlers.alice.kickPlayer as Handler)('carol-sock');
    expect(room.state.finished).toBe(true);
    expectFrozenFinish(['lifecycle-alice-device', 'lifecycle-bob-device', 'lifecycle-carol-device']);
    return handlers;
  };

  const finishRoom = (route: FinishRoute) => {
    if (route === 'commit') return finishByCommit();
    if (route === 'timeout') return finishByTimeout();
    return finishByActiveRemoval();
  };

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    resetLifecycleIo();
    resetStatsMocks();
  });

  afterEach(() => { for (const id of Object.keys(rooms)) deleteRoom(id); });

  it('does not retain transient lobby visitors as game participants', () => {
    const room = rooms[roomId] = createRoom('alice-sock');
    room.state.players = [makePlayer('Alice', 'alice-sock', 'lobby-alice')];
    emitRoomState(lifecycleIo, roomId);
    room.state.players = [makePlayer('Bob', 'bob-sock', 'lobby-bob')];
    emitRoomState(lifecycleIo, roomId);
    expect(room.participantStats?.size ?? 0).toBe(0);
  });

  it('re-captures participant counters on an accepted rematch and clears the prior finish snapshot', () => {
    const handlers = finishByCommit();
    const room = rooms[roomId];
    expect(room.finishedGame?.players?.map(player => player.deviceId).sort()).toEqual(['lifecycle-alice-device', 'lifecycle-bob-device']);

    room.state.players = [
      makePlayer('Alice', 'alice-sock', 'lifecycle-alice-device'),
      makePlayer('Carol', 'carol-sock', 'lifecycle-carol-device'),
    ];
    pushAction(handlers.alice.pushState as Handler, { type: 'start' }, {});

    expect(room.state.finished).toBe(false);
    expect(room.finishedGame).toBeNull();
    expect(room.finishedGameToken).toBeNull();
    expect(room.statsRecordedForGame).toEqual({ devices: new Set(), global: false });
    expectParticipantStats(['lifecycle-alice-device', 'lifecycle-carol-device']);
    expect(room.participantStats?.has('lifecycle-bob-device')).toBe(false);
  });

  it.each(legacyIngressCases)('freezes complete participant rows for $route finish and accepts $ingress stats ingress', async ({ route, ingress }) => {
    const handlers = finishRoom(route);
    const room = rooms[roomId];
    const finishedGameToken = room.finishedGameToken;
    const deviceAck = vi.fn();
    const globalAck = vi.fn();
    const legacyDeviceStats = {
      gamesPlayed: FORGED_SCORE,
      wins: FORGED_SCORE,
      totalTurns: FORGED_SCORE,
      totalScore: FORGED_SCORE,
      busts: 0,
    };
    const legacyGlobalStats = {
      gamesPlayed: FORGED_SCORE,
      totalPlayersSum: FORGED_SCORE,
      mostPlayersInGame: FORGED_SCORE,
      totalRoundsSum: FORGED_SCORE,
    };

    await (handlers.bob.endGameStats as Handler)(ingress === 'legacy'
      ? { deviceId: 'lifecycle-bob-device', stats: legacyDeviceStats, finishedGameToken }
      : { deviceId: 'lifecycle-bob-device', finishedGameToken }, deviceAck);
    await (handlers.alice.submitGlobalStats as Handler)(ingress === 'legacy'
      ? { roomId, payload: legacyGlobalStats, finishedGameToken }
      : { finishedGameToken }, globalAck);

    expect(deviceAck).toHaveBeenCalledWith({ ok: true });
    expect(globalAck).toHaveBeenCalledWith({ ok: true });
    expect(updateDeviceStats).toHaveBeenCalledWith(
      'lifecycle-bob-device',
      expect.objectContaining({
        gamesPlayed: 1,
        wins: 0,
        totalPlayersSum: room.finishedGame?.playerCount,
        mostPlayersInGame: room.finishedGame?.playerCount,
        totalRoundsSum: room.finishedGame?.round,
        longestGameRounds: room.finishedGame?.round,
      }),
      'custom',
    );
    expect(updateGlobalStats).toHaveBeenCalledWith(expect.objectContaining({
      gamesPlayed: 1,
      totalPlayersSum: room.finishedGame?.playerCount,
      mostPlayersInGame: room.finishedGame?.playerCount,
      totalRoundsSum: room.finishedGame?.round,
      longestGameRounds: room.finishedGame?.round,
    }), 'modernized');
  });
});
