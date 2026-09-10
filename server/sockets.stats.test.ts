/** @vitest-environment node */
/** Socket integration coverage for server-derived statistics over protocol v2. */
import type { ChildProcess } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardType, GameMode, Ruleset, TurnSummary } from '../src/types';
import { DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE } from '../src/utils/configValidation';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../src/utils/coreGameEngine';
import { deviceStatsRequest } from '../src/utils/statsApi';
import { applyOnlineGameAction } from './gameActionAuthority';
import { protocolClient, joinTestRoom, acceptOnlineAction, requestPublicState } from './onlineTestClient';
import { createRoom } from './rooms';
import { makeServerPlayer, startTestServer } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

const PORT = TEST_PORTS.socketsStats;
const URL = `http://127.0.0.1:${PORT}`;
const STATS_POLL_ATTEMPTS = 75;
const STATS_POLL_INTERVAL_MS = 40;
const PLAYER_COUNT = 2;
const WINNING_SCORE = DEFAULT_WINNING_SCORE;
const ACTION_SETTLE_DELAY_MS = 10;
const DEFAULT_DECK_ACTION_BOUND = Object.values(DEFAULT_INITIAL_CARDS)
  .reduce((total, count) => total + (count ?? 0), 0);
const CUSTOM_DECK_ACTION_BOUND = PLAYER_COUNT;
const TEST_HOST_SOCKET_ID = 'fixture-host';
const TEST_ALICE_SOCKET_ID = 'fixture-alice';
const TEST_BOB_SOCKET_ID = 'fixture-bob';
// The deterministic two-card deck is deliberately custom, so these end-to-end
// assertions read the custom device bucket and custom global counter.
const GAME_MODE: GameMode = 'custom';

const numericTestDeck = () => {
  const cards = { ...DEFAULT_INITIAL_CARDS };
  for (const card of Object.keys(cards) as CardType[]) cards[card] = 0;
  cards['200'] = PLAYER_COUNT;
  return cards;
};

const emitAck = <T,>(socket: ReturnType<typeof protocolClient>, event: string, data: unknown): Promise<T> =>
  new Promise(resolve => socket.emit(event, data, resolve));

describe('Server Socket E2E — statistics persistence', () => {
  let serverProcess: ChildProcess | undefined;
  const realFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

  const readDeviceStats = async (deviceId: string, mode: GameMode = 'normalized') => {
    const [path, init] = deviceStatsRequest(deviceId, mode);
    return (await realFetch(`${URL}${path}`, init)).json();
  };

  const readGlobalStats = async (ruleset: Ruleset = 'modernized') =>
    (await realFetch(`${URL}/api/stats/global${ruleset === 'classic' ? '?ruleset=classic' : ''}`)).json();

  const pollDeviceStats = async (deviceId: string, mode: GameMode, expectedGames: number) => {
    for (let attempt = 0; attempt < STATS_POLL_ATTEMPTS; attempt++) {
      const row = await readDeviceStats(deviceId, mode);
      if (row.gamesPlayed === expectedGames) return row;
      await new Promise(resolve => setTimeout(resolve, STATS_POLL_INTERVAL_MS));
    }
    throw new Error(`${deviceId} (${mode}) did not record ${expectedGames} games`);
  };

  const classicSummary = (card: CardType, success: boolean, score: number): TurnSummary => {
    const completed = success && ['Plus_Minus', 'Kniffel', 'Kleeblatt'].includes(card);
    const fixedScore = success ? (card === 'Plus_Minus' ? PLUS_MINUS_SCORE : card === 'Kniffel' ? KNIFFEL_SCORE : score) : 0;
    return {
      cards: [{ card, completed }], tuttoCount: completed && card !== 'Feuerwerk' ? (card === 'Kleeblatt' ? 2 : 1) : 0,
      plusMinusScores: completed && card === 'Plus_Minus' ? [0] : [],
      ended: card === 'Stop' ? 'stopCard' : success ? 'banked' : 'null',
      ...(success ? {} : { forfeitedScore: 0 }),
      outcomes: [{ card, scoreBefore: 0, scoreAfter: fixedScore, tuttos: completed && card !== 'Feuerwerk' ? (card === 'Kleeblatt' ? 2 : 1) : 0 }],
    };
  };

  const actionForCard = (card: CardType, succeeds: boolean, ruleset: Ruleset, manualScore = WINNING_SCORE) => {
    const success = succeeds && card !== 'Stop';
    const score = success && !['Plus_Minus', 'Kniffel', 'Kleeblatt'].includes(card) ? manualScore : 0;
    return ruleset === 'classic'
      ? { type: 'commit' as const, score: success && card === 'Plus_Minus' ? PLUS_MINUS_SCORE : success && card === 'Kniffel' ? KNIFFEL_SCORE : score, success,
        summary: classicSummary(card, success, score) }
      : { type: 'commit' as const, score, success };
  };

  const pauseBetweenActions = () => new Promise(resolve => setTimeout(resolve, ACTION_SETTLE_DELAY_MS));

  it.each((Object.keys(DEFAULT_INITIAL_CARDS) as CardType[]).flatMap(card => [
    { card, socketId: TEST_ALICE_SOCKET_ID, succeeds: true, manualScore: WINNING_SCORE },
    { card, socketId: TEST_BOB_SOCKET_ID, succeeds: false, manualScore: 0 },
    { card, socketId: TEST_BOB_SOCKET_ID, succeeds: true, manualScore: 0 },
  ]))('builds an authority-accepted action for $card from $socketId', ({ card, socketId, succeeds, manualScore }) => {
    for (const ruleset of ['modernized', 'classic'] as const) {
      const room = createRoom(TEST_HOST_SOCKET_ID);
      Object.assign(room.state, {
        status: 'playing', ruleset, currentPlayerIndex: socketId === TEST_ALICE_SOCKET_ID ? 0 : 1, currentCard: card,
        players: [makeServerPlayer('Alice', { socketId: TEST_ALICE_SOCKET_ID }),
          makeServerPlayer('Bob', { socketId: TEST_BOB_SOCKET_ID })],
      });
      room.dealtThisTurn = [card];
      expect(applyOnlineGameAction(room, actionForCard(card, succeeds, ruleset, manualScore), socketId)).toBe(true);
    }
  });

  /** Completes only through public-card-driven legal commands, never snapshots. */
  const playFinishedGame = async (roomId: string, ruleset: Ruleset = 'modernized', custom = true) => {
    const alice = protocolClient(URL);
    const bob = protocolClient(URL);
    const aliceDevice = `dev-${roomId}-Alice`;
    const bobDevice = `dev-${roomId}-Bob`;
    await joinTestRoom(alice, roomId, 'Alice', {
      randomOrder: false, turnDuration: 0, ruleset,
      ...(custom ? { initialCards: numericTestDeck() } : {}),
    });
    await joinTestRoom(bob, roomId, 'Bob');
    let finished = await acceptOnlineAction(alice, roomId, { type: 'start' });
    const maxActionsToFinish = custom ? CUSTOM_DECK_ACTION_BOUND : DEFAULT_DECK_ACTION_BOUND;
    for (let actionCount = 0; actionCount < maxActionsToFinish && !finished.finished; actionCount++) {
      const active = finished.players?.[finished.currentPlayerIndex ?? -1];
      if (!active || !finished.currentCard) throw new Error('Server did not expose an active public card');
      const isAlice = active.name === 'Alice';
      finished = await acceptOnlineAction(isAlice ? alice : bob, roomId,
        actionForCard(finished.currentCard, true, ruleset, isAlice ? WINNING_SCORE : 0));
      if (!finished.finished) await pauseBetweenActions();
    }
    if (!finished.finished) throw new Error('Honest action sequence did not finish in the bounded deck cycle');
    return { alice, bob, aliceDevice, bobDevice, finished, close: () => { alice.disconnect(); bob.disconnect(); } };
  };

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => { serverProcess?.kill(); });

  it('records only the server-owned outcome of an honest v2 action sequence', async () => {
    const game = await playFinishedGame('STATS_V2_OWN');
    try {
      const ack = await emitAck<{ ok: boolean }>(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice,
        stats: { gamesPlayed: 99, wins: 0, totalTurns: 99, totalScore: 999_999 },
        finishedGameToken: game.finished.finishedGameToken,
      });
      expect(ack).toEqual({ ok: true });
      const row = await pollDeviceStats(game.aliceDevice, GAME_MODE, 1);
      expect(row).toMatchObject({ gamesPlayed: 1, wins: 1, totalTurns: 1, totalScore: WINNING_SCORE,
        totalPlayersSum: PLAYER_COUNT, totalRoundsSum: 1 });
    } finally { game.close(); }
  }, 10_000);

  it.each([
    { label: 'normalized modernized', ruleset: 'modernized' as const, custom: false, mode: 'normalized' as const },
    { label: 'custom modernized', ruleset: 'modernized' as const, custom: true, mode: 'custom' as const },
    { label: 'normalized classic', ruleset: 'classic' as const, custom: false, mode: 'classic' as const },
    { label: 'custom classic', ruleset: 'classic' as const, custom: true, mode: 'classic_custom' as const },
  ])('records an honest $label game in its authoritative device/global bucket', async ({ ruleset, custom, mode }) => {
    const roomId = `STATS_BUCKET_${mode}`;
    const before = await readGlobalStats(ruleset);
    const game = await playFinishedGame(roomId, ruleset, custom);
    try {
      expect(await emitAck<{ ok: boolean }>(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: { gamesPlayed: 99, wins: 0, totalScore: 999_999 },
        finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: true });
      const device = await pollDeviceStats(game.aliceDevice, mode, 1);
      expect(device.gamesPlayed).toBe(1);
      expect(await readDeviceStats(game.aliceDevice, mode === 'normalized' ? 'custom' : 'normalized')).toEqual({});

      expect(await emitAck<{ ok: boolean }>(game.alice, 'submitGlobalStats', {
        roomId, payload: { gamesPlayed: 99, totalScore: 999_999 }, finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: true });
      const after = await readGlobalStats(ruleset);
      if (custom) expect(after.customGamesPlayed).toBe(before.customGamesPlayed + 1);
      else expect(after.totalGamesPlayed).toBe(before.totalGamesPlayed + 1);
    } finally { game.close(); }
  }, 20_000);

  it('refuses a duplicate finished-game submission but accepts the next action-driven game', async () => {
    const roomId = 'STATS_V2_DEDUP';
    const game = await playFinishedGame(roomId);
    try {
      expect(await emitAck(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: {}, finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: true });
      await pollDeviceStats(game.aliceDevice, GAME_MODE, 1);
      expect(await emitAck(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: { totalScore: 999_999 }, finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: false, reason: 'duplicate' });

      await acceptOnlineAction(game.alice, roomId, { type: 'start' });
      await acceptOnlineAction(game.alice, roomId, { type: 'commit', score: WINNING_SCORE, success: true });
      const nextFinish = await acceptOnlineAction(game.bob, roomId, { type: 'commit', score: 0, success: false });
      // The old finish is no longer merely a duplicate: a genuine rematch has
      // finished, so only the frozen finish token prevents replaying game one.
      expect(await emitAck(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: { totalScore: 999_999 }, finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: false, reason: 'invalid' });
      expect(await emitAck(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: {}, finishedGameToken: nextFinish.finishedGameToken,
      })).toEqual({ ok: true });
      const row = await pollDeviceStats(game.aliceDevice, GAME_MODE, 2);
      expect(row.totalScore).toBe(WINNING_SCORE * PLAYER_COUNT);
    } finally { game.close(); }
  }, 10_000);

  it('rejects a v2 socket attempting to write another device statistics', async () => {
    const game = await playFinishedGame('STATS_V2_FOREIGN');
    try {
      expect(await emitAck(game.alice, 'endGameStats', {
        deviceId: game.bobDevice, stats: { gamesPlayed: 99 }, finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: false, reason: 'unauthorized' });
      expect(await readDeviceStats(game.bobDevice)).toEqual({});
    } finally { game.close(); }
  }, 10_000);

  it('records the host global row from frozen actions rather than the submitted payload', async () => {
    const game = await playFinishedGame('STATS_V2_GLOBAL');
    try {
      const before = await readGlobalStats();
      expect(await emitAck(game.alice, 'submitGlobalStats', {
        roomId: 'STATS_V2_GLOBAL', payload: { gamesPlayed: 99, totalScore: 999_999 },
        finishedGameToken: game.finished.finishedGameToken,
      })).toEqual({ ok: true });
      const after = await readGlobalStats();
      expect(after.customGamesPlayed).toBe(before.customGamesPlayed + 1);
      // A matching device submission is a simple completion signal for the
      // asynchronous database path and its values remain action-derived.
      await emitAck(game.alice, 'endGameStats', {
        deviceId: game.aliceDevice, stats: {}, finishedGameToken: game.finished.finishedGameToken,
      });
      const row = await pollDeviceStats(game.aliceDevice, GAME_MODE, 1);
      expect(row.totalScore).toBe(WINNING_SCORE);
      expect(await requestPublicState(game.alice, 'STATS_V2_GLOBAL')).toMatchObject({ finished: true });
    } finally { game.close(); }
  }, 10_000);
});
