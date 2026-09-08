import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handler } from '../../server/socketTestHarness';

const client = vi.hoisted(() => ({ connected: true, handlers: {} as Record<string, Handler>, emit: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({
  id: 'host', get connected() { return client.connected; },
  on: (event: string, handler: Handler) => { client.handlers[event] = handler; },
  off: vi.fn(), disconnect: vi.fn(), emit: client.emit,
})) }));
vi.mock('../../server/database', () => ({
  getDeviceStats: vi.fn().mockResolvedValue(null), updateDeviceStats: vi.fn().mockResolvedValue(true),
  updateGlobalStats: vi.fn().mockResolvedValue(1),
}));

import { useGameStore, _resetTimersForTests, _resetSocketSliceForTests } from './useGameStore';
import { disconnectSocket } from './socketRef';
import { createRoom, rooms, deleteRoom, emitRoomState } from '../../server/rooms';
import { registerRoomHandlers } from '../../server/socketRoomHandlers';
import { registerGameStateHandlers } from '../../server/socketGameStateHandlers';
import { makeFakeSocket, makeFakeIo, makeServerPlayer } from '../../server/socketTestHarness';
import { advanceTurnOnTimeout } from '../../server/turnTimers';
import { registerStatsHandlers } from '../../server/socketStatsHandlers';
import { updateDeviceStats, updateGlobalStats } from '../../server/database';
import { PARKED_EMIT_MAX_AGE_MS } from './socketSlice';

const ROOM = 'PROTOCOL-ROOM';
const SCORE = 500;
const wire = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

beforeEach(() => {
  vi.useFakeTimers();
  client.connected = true;
  client.handlers = {};
  client.emit.mockReset();
  vi.mocked(updateDeviceStats).mockClear();
  vi.mocked(updateGlobalStats).mockClear();
  useGameStore.getState().reset();
  _resetTimersForTests();
  useGameStore.getState().connectSocket();
});
afterEach(() => {
  for (const id of Object.keys(rooms)) deleteRoom(id);
  _resetTimersForTests();
  _resetSocketSliceForTests();
  disconnectSocket();
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

function stage() {
  const fake = makeFakeSocket('host');
  const session = { roomId: ROOM as string | null, username: 'Alice' as string | null };
  const { io, emit } = makeFakeIo();
  Object.assign(io, { sockets: { sockets: new Map() } });
  registerRoomHandlers({ socket: fake.socket, io, session });
  registerGameStateHandlers({ socket: fake.socket, io, session });
  registerStatsHandlers({ socket: fake.socket, io, session });
  const room = rooms[ROOM] = createRoom('host');
  Object.assign(room.state, {
    status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['200', '300', '400'],
    turnDuration: 0, randomOrder: false,
    players: [makeServerPlayer('Alice', { socketId: 'host', deviceId: 'a' }),
      makeServerPlayer('Bob', { socketId: 'guest', deviceId: 'b' })],
  });
  useGameStore.setState({ roomId: ROOM, myName: 'Alice', deviceId: 'a', mode: 'online', isOnline: true, isHost: true });
  emit.mockImplementation((event, payload) => { if (client.connected) client.handlers[event]?.(wire(payload)); });
  vi.mocked(fake.socket.emit).mockImplementation((event, ...args) => {
    client.handlers[event]?.(...args.map(wire));
    return true;
  });
  emitRoomState(io, ROOM);
  client.emit.mockImplementation((event: string, payload: unknown, ack: unknown) => fake.handlers[event]?.(wire(payload), ack));
  return { fake, io, room, emit };
}

describe('gameplay preconditions through the real store and JSON transport', () => {
  it('refuses a parked host move after timeout even with no guest action', async () => {
    const { fake, io, room } = stage();
    client.connected = false;
    client.handlers.disconnect();
    fake.handlers.disconnect();
    useGameStore.getState().nextTurn(SCORE);
    advanceTurnOnTimeout(io, ROOM);
    const authoritative = wire(room.state);
    client.connected = true;
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.state.players.map(({ score, totalTurns }) => ({ score, totalTurns })))
      .toEqual(authoritative.players.map(({ score, totalTurns }) => ({ score, totalTurns })));
    expect(room.state.historyLog).toEqual(authoritative.historyLog);
    expect(useGameStore.getState().players[0].score).toBe(0);
  });

  it('accepts a same-turn parked move after presence-only disconnect and rejoin', async () => {
    const { fake, room } = stage();
    client.connected = false;
    client.handlers.disconnect();
    fake.handlers.disconnect();
    useGameStore.getState().nextTurn(SCORE);
    client.connected = true;
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.state.players[0].score).toBe(SCORE);
    expect(room.state.currentPlayerIndex).toBe(1);
  });

  it('rejects replay when undo has returned to exactly the same round and seat', () => {
    const { fake, room } = stage();
    useGameStore.getState().nextTurn(SCORE);
    const oldPush = client.emit.mock.calls.find(([event]) => event === 'pushState')![1];
    useGameStore.getState().undo();
    expect(room.state.currentPlayerIndex).toBe(0);
    const ack = vi.fn();
    fake.handlers.pushState(wire(oldPush), ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'stale-base' });
    expect(room.state.players[0].score).toBe(0);
  });

  it('keeps consecutive optimistic turns when broadcasts and acks are delayed', () => {
    const { fake, room, emit } = stage();
    emit.mockImplementation(() => undefined);
    const sends: Array<() => void> = [];
    client.emit.mockImplementation((event: string, payload: unknown, ack: unknown) => {
      if (event === 'pushState') sends.push(() => fake.handlers[event](wire(payload), ack));
    });
    useGameStore.getState().nextTurn(SCORE);
    useGameStore.getState().nextTurn(SCORE);
    sends.forEach(send => send());
    expect(room.state.players.map(player => player.score)).toEqual([SCORE, SCORE]);
    expect(room.state.round).toBe(2);
    expect(client.emit.mock.calls.filter(([event]) => event === 'requestState')).toHaveLength(0);
  });

  it('preserves the latest prediction through ancestor presence and intermediate echoes', () => {
    const { fake, room, io } = stage();
    const sends: Array<() => void> = [];
    client.emit.mockImplementation((event: string, payload: unknown, ack: unknown) => {
      if (event === 'pushState') sends.push(() => fake.handlers[event](wire(payload), ack));
    });
    useGameStore.getState().nextTurn(SCORE);
    emitRoomState(io, ROOM); // same gameplay, before the first push reached the server
    expect(useGameStore.getState().currentPlayerIndex).toBe(1);
    useGameStore.getState().nextTurn(SCORE);
    sends[0]();
    expect(useGameStore.getState().round).toBe(2);
    expect(useGameStore.getState().players[1].score).toBe(SCORE);
    sends[1]();
    expect(useGameStore.getState().players.map(player => player.score))
      .toEqual(room.state.players.map(player => player.score));
    expect(useGameStore.getState().gameplayToken).toBe(room.gameplayToken);
  });

  it('coalesces disconnected actions against their original authoritative base', async () => {
    const { room } = stage();
    client.connected = false;
    client.handlers.disconnect();
    useGameStore.getState().nextTurn(SCORE);
    useGameStore.getState().nextTurn(SCORE);
    client.connected = true;
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.state.players.map(player => player.score)).toEqual([SCORE, SCORE]);
    expect(room.state.round).toBe(2);
    expect(useGameStore.getState().gameplayToken).toBe(room.gameplayToken);
  });

  it('applies unchanged server state when an expired parked prediction is dropped', async () => {
    const { room } = stage();
    client.connected = false;
    client.handlers.disconnect();
    useGameStore.getState().nextTurn(SCORE);
    await vi.advanceTimersByTimeAsync(PARKED_EMIT_MAX_AGE_MS + 1);
    client.connected = true;
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(useGameStore.getState().players[0].score).toBe(0);
    expect(useGameStore.getState().gameplayToken).toBe(room.gameplayToken);
  });

  it('captures pre-mutation identity for end, start, nextTurn and undo', () => {
    const { room } = stage();
    // A bare Stop is deliberately not undoable. Keep this lifecycle fixture
    // deterministic rather than sometimes asking undo to do nothing.
    room.state.initialCards = { '300': 1 };
    useGameStore.setState({ initialCards: { '300': 1 } });
    for (const action of [() => useGameStore.getState().endGame(), () => useGameStore.getState().startGame(),
      () => useGameStore.getState().nextTurn(SCORE), () => useGameStore.getState().undo()]) {
      const base = room.gameplayToken;
      action();
      const lastPush = client.emit.mock.calls.filter(([event]) => event === 'pushState').at(-1)![1];
      expect(lastPush.base).toBe(base);
      expect(lastPush.mutationId).toBe(room.gameplayToken);
      expect(room.gameplayToken).not.toBe(base);
    }
  });

  it('keeps a newer disconnected snapshot parked until the rejoin finishes', async () => {
    const { room } = stage();
    client.connected = false;
    client.handlers.disconnect();
    useGameStore.getState().nextTurn(SCORE);
    client.connected = true;
    // Transport is back, but the connect/rejoin handshake has not finished.
    useGameStore.getState().nextTurn(SCORE);
    expect(client.emit.mock.calls.filter(([event]) => event === 'pushState')).toHaveLength(0);
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(room.state.players.map(player => player.score)).toEqual([SCORE, SCORE]);
  });

  it('keeps a coalesced finish and its statistics together while waiting for rejoin', async () => {
    const { room } = stage();
    room.state.players[0].score = room.state.winningScore;
    useGameStore.setState({ players: wire(room.state.players) });
    client.connected = false;
    client.handlers.disconnect();
    useGameStore.getState().nextTurn(0);
    client.connected = true;
    useGameStore.getState().nextTurn(0);
    expect(useGameStore.getState().finished).toBe(true);
    expect(client.emit.mock.calls.filter(([event]) => event === 'endGameStats' || event === 'submitGlobalStats')).toHaveLength(0);
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    expect(updateGlobalStats).toHaveBeenCalledTimes(1);
  });

  it('coalesces a newer action against the ancestor of a refused rejoin retry', async () => {
    const { room } = stage();
    client.handlers.connect();
    await vi.advanceTimersByTimeAsync(0);
    client.emit.mockImplementationOnce((_event: string, _payload: unknown, ack: Handler) => ack({ ok: false, reason: 'unauthorized' }));
    useGameStore.getState().nextTurn(SCORE);
    expect(room.state.players[0].score).toBe(0);
    useGameStore.getState().nextTurn(SCORE);
    expect(room.state.players.map(player => player.score)).toEqual([SCORE, SCORE]);
  });

  it('omits preconditions for a server that does not advertise token support', () => {
    const { room } = stage();
    client.handlers.gameState(wire(room.state));
    useGameStore.getState().nextTurn(SCORE);
    const payload = client.emit.mock.calls.find(([event]) => event === 'pushState')![1];
    expect(payload).not.toHaveProperty('base');
    expect(payload).not.toHaveProperty('mutationId');
  });

  it('keeps finishing statistics ahead of a rapid rematch even when acks are delayed', async () => {
    const { fake, room, emit } = stage();
    room.state.players[0].score = room.state.winningScore;
    room.state.currentPlayerIndex = 1;
    useGameStore.setState({ players: wire(room.state.players), currentPlayerIndex: 1 });
    emit.mockImplementation(() => undefined);
    client.emit.mockImplementation((event: string, payload: unknown) => fake.handlers[event]?.(wire(payload), () => undefined));
    useGameStore.getState().nextTurn(0);
    const finishingToken = room.finishedGameToken;
    useGameStore.getState().startGame();
    await vi.advanceTimersByTimeAsync(0);
    expect(updateDeviceStats).toHaveBeenCalledTimes(1);
    expect(updateGlobalStats).toHaveBeenCalledTimes(1);
    expect(room.state.finished).toBe(false);
    expect(room.finishedGameToken).toBeNull();
    const submitted = client.emit.mock.calls.find(([event]) => event === 'endGameStats')![1];
    expect(submitted.finishedGameToken).toBe(finishingToken);
  });

  it('resyncs a rate-limited prediction so the next valid action can land', () => {
    const { fake, room } = stage();
    client.emit.mockImplementationOnce((_event: string, _payload: unknown, ack: Handler) => ack({ ok: false, reason: 'rate-limited' }));
    useGameStore.getState().nextTurn(SCORE);
    expect(useGameStore.getState().gameplayToken).toBe(room.gameplayToken);
    useGameStore.getState().nextTurn(SCORE);
    expect(room.state.players[0].score).toBe(SCORE);
    expect(fake.handlers).toHaveProperty('requestState');
  });

  it('ignores a late refusal from a room that has already been left', () => {
    stage();
    let reply: Handler = () => undefined;
    client.emit.mockImplementationOnce((_event: string, _payload: unknown, ack: Handler) => { reply = ack; });
    useGameStore.getState().nextTurn(SCORE);
    useGameStore.getState().leaveRoom();
    const nextRoom = `${ROOM}-NEXT`;
    useGameStore.setState({ roomId: nextRoom, mode: 'online', isOnline: true });
    reply({ ok: false, reason: 'no-room' });
    expect(useGameStore.getState().roomId).toBe(nextRoom);
    expect(useGameStore.getState().mode).toBe('online');
  });

  it('restores absent optional records through a real online turn and undo', () => {
    const { room } = stage();
    useGameStore.getState().nextTurn(SCORE);
    expect(room.state.players[0].highestTurnScore).toBe(SCORE);
    useGameStore.getState().undo();
    expect(room.state.players[0].highestTurnScore).toBeUndefined();
    expect(useGameStore.getState().players[0].highestTurnScore).toBeUndefined();
  });

  it('does not record a refused optimistic finish into a different finished state', async () => {
    const { fake, room } = stage();
    room.state.players[0].score = room.state.winningScore;
    room.state.currentPlayerIndex = 1;
    useGameStore.setState({ players: wire(room.state.players), currentPlayerIndex: 1 });
    advanceTurnOnTimeout(makeFakeIo().io, ROOM);
    expect(room.state.finished).toBe(true);
    const replies: Array<() => void> = [];
    client.emit.mockImplementation((event: string, payload: unknown, ack: Handler) => {
      // Like a real transport, a refusal cannot return before nextTurn has
      // emitted the stats that immediately follow its finishing snapshot.
      fake.handlers[event]?.(wire(payload), (...args: unknown[]) => replies.push(() => ack?.(...args)));
    });
    useGameStore.getState().nextTurn(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(updateDeviceStats).not.toHaveBeenCalled();
    expect(updateGlobalStats).not.toHaveBeenCalled();
    replies.forEach(reply => reply());
  });
});
