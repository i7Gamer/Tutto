/** @vitest-environment node */
// This must precede the database import so this file gets its own in-memory
// SQLite database rather than a developer's local statistics file.
process.env.TEST_DB = 'true';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import database from './database';
import { createRoom, deleteRoom, emitRoomState, rooms } from './rooms';
import { applyOnlineGameAction } from './gameActionAuthority';
import { readDeckContext, settleDeck } from './deckAuthority';
import { registerStatsHandlers } from './socketStatsHandlers';
import { writeDeviceStatsOnce } from './statsWriteCoordinator';
import { makeFakeIo, makeFakeSocket, makeServerPlayer, type Handler } from './socketTestHarness';
import { DEFAULT_INITIAL_CARDS } from '../src/utils/configValidation';
import type { CardType, StatsPayload } from '../src/types';
import { nonNull } from '../src/testing/factories';

const MODE = 'normalized' as const;
const ROUND_COUNT = 7;
const PLAYER_COUNT = 2;
const DEVICE_ID = 'accounting-device';

const game = () => ({ devices: new Map(), global: false });

const singleNumericDeck = () => {
  const cards = { ...DEFAULT_INITIAL_CARDS };
  for (const card of Object.keys(cards) as CardType[]) cards[card] = 0;
  cards['200'] = PLAYER_COUNT;
  return cards;
};

describe('finish accounting database regression', () => {
  beforeAll(async () => {
    await database.initDb();
  });

  beforeEach(async () => {
    await database.knex('device_statistics').del();
    for (const roomId of Object.keys(rooms)) deleteRoom(roomId);
  });

  afterAll(async () => {
    await database.knex.destroy();
  });

  it('allows a full fallback after a pending departed verdict fails, without publishing a phantom verdict', async () => {
    const dedup = game();
    const departedVerdict: StatsPayload = {
      gamesPlayed: 1, wins: 1, totalPlayersSum: PLAYER_COUNT,
      mostPlayersInGame: PLAYER_COUNT, totalRoundsSum: ROUND_COUNT,
      longestGameRounds: ROUND_COUNT,
    };
    const fullFallback: StatsPayload = {
      ...departedVerdict, totalTurns: 4, totalScore: 1200, busts: 1,
    };

    await expect(writeDeviceStatsOnce(dedup, DEVICE_ID, 'verdict-only', async () => {
      throw new Error('departed write failed before commit');
    })).rejects.toThrow('departed write failed before commit');
    expect(dedup.devices.has(DEVICE_ID)).toBe(false);

    await writeDeviceStatsOnce(dedup, DEVICE_ID, 'full', async () => {
      await database.updateDeviceStats(DEVICE_ID, fullFallback, MODE);
    });

    const row = nonNull(await database.getDeviceStats(DEVICE_ID, MODE));
    expect(dedup.devices.get(DEVICE_ID)).toBe('full');
    expect(row.gamesPlayed).toBe(1);
    expect(row.wins).toBe(1);
    expect(row.totalPlayersSum).toBe(PLAYER_COUNT);
    expect(row.totalRoundsSum).toBe(ROUND_COUNT);
    expect(row.longestGameRounds).toBe(ROUND_COUNT);
    expect(row.totalTurns).toBe(4);
    expect(row.totalScore).toBe(1200);
    expect(row.busts).toBe(1);
  });

  it('merges a returned full row after a committed verdict without duplicating game, streak, or round totals', async () => {
    const dedup = game();
    const verdict: StatsPayload = {
      gamesPlayed: 1, wins: 1, totalPlayersSum: PLAYER_COUNT,
      mostPlayersInGame: PLAYER_COUNT, totalRoundsSum: ROUND_COUNT,
      longestGameRounds: ROUND_COUNT,
    };

    await writeDeviceStatsOnce(dedup, DEVICE_ID, 'verdict-only', async () => {
      await database.updateDeviceStats(DEVICE_ID, verdict, MODE);
    });
    await writeDeviceStatsOnce(dedup, DEVICE_ID, 'full', async () => {
      await database.updateDeviceStats(DEVICE_ID, {
        // These are the handler's merge overrides: verdict-owned sums are not
        // added twice and wins is absent so its streak CASE cannot run again.
        gamesPlayed: 0, totalPlayersSum: 0, totalRoundsSum: 0,
        totalTurns: 4, totalScore: 1200, busts: 1,
      }, MODE);
    });

    const row = nonNull(await database.getDeviceStats(DEVICE_ID, MODE));
    expect(dedup.devices.get(DEVICE_ID)).toBe('full');
    expect(row.gamesPlayed).toBe(1);
    expect(row.wins).toBe(1);
    expect(row.currentWinStreak).toBe(1);
    expect(row.bestWinStreak).toBe(1);
    expect(row.totalPlayersSum).toBe(PLAYER_COUNT);
    expect(row.totalRoundsSum).toBe(ROUND_COUNT);
    expect(row.longestGameRounds).toBe(ROUND_COUNT);
    expect(row.totalTurns).toBe(4);
    expect(row.totalScore).toBe(1200);
    expect(row.busts).toBe(1);
  });

  it('persists frozen server counters from an actual start and finish action, ignoring a forged submission', async () => {
    const roomId = 'FROZEN-ACTION-FINISH';
    const alice = makeServerPlayer('Alice', { deviceId: 'frozen-alice', socketId: 'alice-socket' });
    const bob = makeServerPlayer('Bob', { deviceId: 'frozen-bob', socketId: 'bob-socket' });
    const room = rooms[roomId] = createRoom('alice-socket');
    Object.assign(room.state, {
      players: [alice, bob], initialCards: singleNumericDeck(), randomOrder: false,
      winningScore: 1000,
    });

    // This is the same lifecycle the pushState handler owns: kickoff captures
    // seats, each accepted action broadcasts/captures, and the finish broadcast
    // freezes the final counters before the stats handler sees any client data.
    expect(applyOnlineGameAction(room, { type: 'start' }, 'alice-socket')).toBe(true);
    room.participantStats = new Map();
    room.startRoster = room.state.players.map(player => ({ deviceId: player.deviceId, name: player.name }));
    let before = readDeckContext(room.state);
    settleDeck(room, before, true);
    emitRoomState(makeFakeIo().io, roomId);

    before = readDeckContext(room.state);
    expect(applyOnlineGameAction(room, { type: 'commit', score: 1000, success: true }, 'alice-socket')).toBe(true);
    settleDeck(room, before, false);
    emitRoomState(makeFakeIo().io, roomId);

    before = readDeckContext(room.state);
    expect(applyOnlineGameAction(room, { type: 'commit', score: 0, success: false }, 'bob-socket')).toBe(true);
    settleDeck(room, before, false);
    emitRoomState(makeFakeIo().io, roomId);

    expect(room.state.finished).toBe(true);
    expect(room.finishedGame?.winnerDeviceIds).toEqual(['frozen-alice']);
    expect(room.finishedGame?.players?.find(player => player.deviceId === 'frozen-bob')).toEqual(expect.objectContaining({
      totalTurns: 1, busts: 1, score: 0,
    }));

    const fake = makeFakeSocket('bob-socket');
    registerStatsHandlers({ io: makeFakeIo().io, socket: fake.socket, session: { roomId, username: 'Bob' } });
    const ack = vi.fn();
    await (fake.handlers.endGameStats as Handler)({
      deviceId: 'frozen-bob',
      // A malicious client cannot replace the frozen action outcome.
      stats: { gamesPlayed: 99, wins: 99, totalTurns: 99, totalScore: 999_999, busts: 0 },
      finishedGameToken: room.finishedGameToken,
    }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    const row = nonNull(await database.getDeviceStats('frozen-bob', MODE));
    expect(row.gamesPlayed).toBe(1);
    expect(row.wins).toBe(0);
    expect(row.totalTurns).toBe(1);
    expect(row.busts).toBe(1);
    expect(row.totalScore).toBe(0);
    expect(row.totalPlayersSum).toBe(PLAYER_COUNT);
    expect(row.totalRoundsSum).toBe(1);
    expect(row.longestGameRounds).toBe(1);
  });
});
