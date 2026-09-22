/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoom, deleteRoom, emitRoomState, rooms } from './rooms';
import { registerStatsHandlers } from './socketStatsHandlers';
import { makeFakeIo, makeFakeSocket, makeServerPlayer } from './socketTestHarness';
import type { ConnectionSession } from './socketContext';
import type { Room } from './roomTypes';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));
import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';

const ROOM_ID = 'STATS-WAITER-IDENTITY';
const HOST_SOCKET = 'host-socket';
const RETURNED_SOCKET = 'returned-socket';
const DEVICE_ID = 'departed-device';
const WINNING_SCORE = 6_000;
const FINAL_TIME_SECONDS = 45;
const FORGED_COUNTER = 999_999;
const FAILED_WRITE_MESSAGE = 'held departed write failed';
type WaitingFinish = { room: Room; session: ConnectionSession };

const identityChanges: {
  name: string;
  reason: 'invalid' | 'unauthorized' | null;
  change: (finish: WaitingFinish) => void;
}[] = [
  { name: 'the unchanged room and returning seat', reason: null, change: () => undefined },
  { name: 'room deletion', reason: 'invalid', change: () => deleteRoom(ROOM_ID) },
  { name: 'replacement room under the same ID', reason: 'invalid', change: ({ room }) => {
    deleteRoom(ROOM_ID);
    // Matching finish data and dedup references do not make this the old room.
    // Reuse them deliberately so only the room-object guard can reject it.
    rooms[ROOM_ID] = {
      ...createRoom(HOST_SOCKET),
      state: { ...room.state, players: [...room.state.players] },
      finishedGame: room.finishedGame,
      finishedGameToken: room.finishedGameToken,
      statsRecordedForGame: room.statsRecordedForGame,
    };
  } },
  { name: 'a rematch dedup object', reason: 'invalid', change: ({ room }) => {
    room.statsRecordedForGame = { devices: new Set(), global: false };
  } },
  { name: 'a newer finish token', reason: 'invalid', change: ({ room }) => {
    room.finishedGameToken = 'newer-finish';
  } },
  { name: 'a game no longer finished', reason: 'invalid', change: ({ room }) => {
    room.state.finished = false;
  } },
  { name: 'a session moved to another room', reason: 'unauthorized', change: ({ session }) => {
    session.roomId = 'OTHER-ROOM';
  } },
  { name: 'the seat taken by another socket', reason: 'unauthorized', change: ({ room }) => {
    room.state.players.find(player => player.deviceId === DEVICE_ID)!.socketId = 'replacement-socket';
  } },
  { name: 'the socket assigned to another device', reason: 'unauthorized', change: ({ room }) => {
    room.state.players.find(player => player.socketId === RETURNED_SOCKET)!.deviceId = 'replacement-device';
  } },
  { name: 'the returning seat removed', reason: 'unauthorized', change: ({ room }) => {
    room.state.players = room.state.players.filter(player => player.deviceId !== DEVICE_ID);
  } },
];

describe.each(['legacy', 'reduced'] as const)('%s statistics waiter identity', shape => {
  beforeEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.mocked(getDeviceStats).mockReset().mockResolvedValue(null);
    vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
    vi.mocked(updateGlobalStats).mockReset().mockResolvedValue(1);
  });
  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
    vi.restoreAllMocks();
  });

  it.each(identityChanges)('settles a held waiter for $name', async ({ change, reason }) => {
    const alice = makeServerPlayer('Alice', { socketId: HOST_SOCKET, deviceId: 'host-device', score: WINNING_SCORE });
    const bob = makeServerPlayer('Bob', { socketId: 'departed-socket', deviceId: DEVICE_ID, disconnected: true });
    const room = rooms[ROOM_ID] = createRoom(HOST_SOCKET);
    room.normalizedGame = false;
    room.participantStats = new Map([[alice.deviceId, { ...alice }], [bob.deviceId, { ...bob }]]);
    Object.assign(room.state, {
      players: [alice, bob], status: 'playing', finished: true,
      currentPlayerIndex: null, gameTimeInSeconds: FINAL_TIME_SECONDS,
    });
    let rejectDepartedWrite!: (error: Error) => void;
    vi.mocked(updateDeviceStats).mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => {
      rejectDepartedWrite = reject;
    }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { io } = makeFakeIo();
    emitRoomState(io, ROOM_ID);
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    const oldDedup = room.statsRecordedForGame;
    expect(oldDedup.devices.has(DEVICE_ID)).toBe(false);

    // Rejoin and submit while the departed-seat writer still owns the reservation.
    Object.assign(bob, { socketId: RETURNED_SOCKET, disconnected: false });
    const fake = makeFakeSocket(RETURNED_SOCKET);
    const session = { roomId: ROOM_ID, username: 'Bob' };
    registerStatsHandlers({ io, socket: fake.socket, session });
    const ack = vi.fn();
    const submission = fake.handlers.endGameStats({
      deviceId: DEVICE_ID,
      finishedGameToken: room.finishedGameToken,
      ...(shape === 'legacy' ? { stats: { gamesPlayed: FORGED_COUNTER, wins: FORGED_COUNTER } } : {}),
    }, ack);
    expect(ack).not.toHaveBeenCalled();
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);

    change({ room, session });
    const currentDedup = rooms[ROOM_ID]?.statsRecordedForGame;
    rejectDepartedWrite(new Error(FAILED_WRITE_MESSAGE));
    await submission;

    const accepted = reason === null;
    expect(ack).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledWith(accepted ? { ok: true } : { ok: false, reason });
    // With no identity change the released waiter really writes; refusals must
    // prevent that second dispatch rather than merely return a different ack.
    const expectedWrites = accepted ? 2 : 1;
    expect(updateDeviceStats).toHaveBeenCalledTimes(expectedWrites);
    expect(oldDedup.devices.has(DEVICE_ID)).toBe(accepted);
    expect(currentDedup?.devices.has(DEVICE_ID) ?? false).toBe(accepted);
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith('[recordDepartedSeatsStats] error:',
      expect.objectContaining({ message: FAILED_WRITE_MESSAGE })));
  });
});
