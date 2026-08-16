/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'socket.io';
import { registerStatsHandlers } from './socketStatsHandlers';
import { makeFakeSocket } from './socketTestHarness';
import { rooms, createRoom, deleteRoom } from './rooms';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import type { ServerPlayer } from './roomTypes';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));
import { getDeviceStats, updateDeviceStats } from './database';

const makeFakeIo = () => {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, emit };
};

const makePlayer = (name: string, socketId: string, deviceId: string): ServerPlayer => ({
  name,
  deviceId,
  socketId,
  score: 0,
  position: 1,
  disconnected: false,
  ...zeroedPlayerStats(),
});

describe('endGameStats win-streak refresh', () => {
  const roomId = 'STREAK-ROOM';

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset();
  });

  it('writes the refreshed streak to the CURRENT seat, not a pre-await snapshot', async () => {
    // Between the two awaits a players-carrying push (e.g. the host's Play
    // Again) can rebuild every roster entry — writing to the object resolved
    // before the awaits would update a detached copy and broadcast the very
    // stale streak this refresh exists to fix.
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', 'dev-alice')],
    });

    // The interleaved push, simulated at the first await: every roster entry
    // is replaced by a copy.
    vi.mocked(updateDeviceStats).mockImplementation(async () => {
      rooms[roomId].state.players = rooms[roomId].state.players.map(p => ({ ...p }));
      return 1;
    });
    vi.mocked(getDeviceStats).mockResolvedValue({ currentWinStreak: 5 } as never);

    const { io } = makeFakeIo();
    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io, socket: fake.socket, session: { roomId, username: 'Alice' } });

    fake.handlers['endGameStats']({ deviceId: 'dev-alice', stats: { gamesPlayed: 1, wins: 1 } });

    await vi.waitFor(() => expect(getDeviceStats).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(rooms[roomId].state.players[0].winStreak).toBe(5));
  });
});

describe('endGameStats dedup rollback', () => {
  // The per-device dedup is added BEFORE the write so a concurrent duplicate
  // can't slip through, which makes rolling it back on failure the delicate
  // part: reopen it when nothing was committed (a retry must still be able to
  // record the game), but leave it closed once the row is in — otherwise the
  // retry counts the same game twice. Hence the handler's two separate
  // catches; these pin that they stay separate.
  const roomId = 'DEDUP-ROLLBACK-ROOM';
  const deviceId = 'dev-alice';
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset();
    vi.mocked(updateDeviceStats).mockReset();
    // Both failure paths report through console.error. Spying keeps the
    // expected noise out of the run and, more importantly, gives each test a
    // deterministic signal that the catch it cares about has actually run —
    // the handler is fire-and-forget, so there is nothing else to await.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** A room sitting on a finished default-config game, with Alice at the table. */
  const stageFinishedGame = () => {
    rooms[roomId] = createRoom('host-sock');
    Object.assign(rooms[roomId].state, {
      status: 'playing', finished: true, currentPlayerIndex: null,
      players: [makePlayer('Alice', 'alice-sock', deviceId)],
    });
  };

  const submitStats = () => {
    const { io } = makeFakeIo();
    const fake = makeFakeSocket('alice-sock');
    registerStatsHandlers({ io, socket: fake.socket, session: { roomId, username: 'Alice' } });
    fake.handlers['endGameStats']({ deviceId, stats: { gamesPlayed: 1, wins: 1 } });
  };

  it('keeps the dedup when only the post-write streak refresh fails', async () => {
    stageFinishedGame();
    vi.mocked(updateDeviceStats).mockResolvedValue(true);
    vi.mocked(getDeviceStats).mockRejectedValue(new Error('read failed'));

    submitStats();

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    // The device row IS committed — a rollback here would let a retry (a
    // reconnect re-firing the client's "finished just became true" path)
    // record the very same game a second time.
    expect(rooms[roomId].statsRecordedForGame.devices.has(deviceId)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('[endGameStats] streak refresh error:', expect.anything());
  });

  it('still rolls back when the write itself fails', async () => {
    stageFinishedGame();
    vi.mocked(updateDeviceStats).mockRejectedValue(new Error('write failed'));

    submitStats();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[endGameStats] error:', expect.anything()));
    // Nothing was committed, so the dedup must reopen — otherwise a transient
    // DB error would permanently swallow this game's stats.
    expect(rooms[roomId].statsRecordedForGame.devices.has(deviceId)).toBe(false);
    // And the handler must not have gone on to the refresh at all.
    expect(getDeviceStats).not.toHaveBeenCalled();
  });
});
