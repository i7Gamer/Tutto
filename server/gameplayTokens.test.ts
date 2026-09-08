/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGameStateHandlers } from './socketGameStateHandlers';
import { advanceTurnOnTimeout } from './turnTimers';
import { handleActivePlayerRemoved, createRoom, deleteRoom, emitRoomState, rooms } from './rooms';
import { makeFakeIo, makeFakeSocket, makeServerPlayer } from './socketTestHarness';

const ROOM_ID = 'GAMEPLAY-TOKEN-ROOM';
const HOST_SOCKET = 'host-socket';
const ACTIVE_SOCKET = 'active-socket';
const BASE_TOKEN = '11111111-1111-4111-8111-111111111111';
const NEXT_TOKEN = '22222222-2222-4222-8222-222222222222';
const OTHER_TOKEN = '33333333-3333-4333-8333-333333333333';
const MALFORMED_TOKEN = 'not-a-uuid';

const makePlayingRoom = () => {
  const room = rooms[ROOM_ID] = createRoom(HOST_SOCKET);
  room.gameplayToken = BASE_TOKEN;
  Object.assign(room.state, {
    status: 'playing',
    finished: false,
    currentPlayerIndex: 0,
    currentCard: '300',
    cards: ['200', '400'],
    round: 1,
    turnDuration: 0,
    turnStartTime: null,
    players: [
      makeServerPlayer('Alice', { socketId: ACTIVE_SOCKET }),
      makeServerPlayer('Bob', { socketId: HOST_SOCKET }),
    ],
  });
  return room;
};

const registerPush = (socketId = ACTIVE_SOCKET, username = 'Alice') => {
  const fake = makeFakeSocket(socketId);
  const { io } = makeFakeIo();
  registerGameStateHandlers({ io, socket: fake.socket, session: { roomId: ROOM_ID, username } });
  return fake.handlers.pushState;
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const id of Object.keys(rooms)) deleteRoom(id);
});

afterEach(() => {
  for (const id of Object.keys(rooms)) deleteRoom(id);
  vi.useRealTimers();
});

describe('gameplay token CAS', () => {
  it.each([
    { label: 'base only', data: { base: BASE_TOKEN } },
    { label: 'mutation only', data: { mutationId: NEXT_TOKEN } },
    { label: 'malformed base', data: { base: MALFORMED_TOKEN, mutationId: NEXT_TOKEN } },
    { label: 'malformed mutation', data: { base: BASE_TOKEN, mutationId: MALFORMED_TOKEN } },
    { label: 'same base and mutation', data: { base: BASE_TOKEN, mutationId: BASE_TOKEN } },
  ])('rejects a present invalid precondition ($label) before mutation', ({ data }) => {
    const room = makePlayingRoom();
    const pushState = registerPush();
    const ack = vi.fn();
    pushState({ roomId: ROOM_ID, newState: { round: 2 }, ...data }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'refused' });
    expect(room.gameplayToken).toBe(BASE_TOKEN);
    expect(room.state.round).toBe(1);
  });

  it('keeps legacy pushes accepted and rotates the server token', () => {
    const room = makePlayingRoom();
    const pushState = registerPush();
    const ack = vi.fn();

    pushState({ roomId: ROOM_ID, newState: { round: 2 } }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true, stateVersion: 1 });
    expect(room.state.round).toBe(2);
    expect(room.gameplayToken).not.toBe(BASE_TOKEN);
  });

  it('keeps the token stable for a presence-only broadcast', () => {
    const room = makePlayingRoom();
    const { io } = makeFakeIo();

    emitRoomState(io, ROOM_ID);

    expect(room.gameplayToken).toBe(BASE_TOKEN);
  });

  it('rotates for a server-dealt draw', () => {
    const room = makePlayingRoom();
    room.state.turnDuration = 60;
    room.turnTimerState = { lastCard: '300', lastPlayerIndex: 0, lastDeckSize: 2, restartsThisTurn: 0 };
    const fake = makeFakeSocket(ACTIVE_SOCKET);
    const { io } = makeFakeIo();
    registerGameStateHandlers({ io, socket: fake.socket, session: { roomId: ROOM_ID, username: 'Alice' } });
    const before = room.gameplayToken;
    const ack = vi.fn();

    fake.handlers.drawCard({ roomId: ROOM_ID }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true, card: '200' });
    expect(room.gameplayToken).not.toBe(before);
  });

  it('rotates for a server timeout advance', () => {
    const room = makePlayingRoom();
    const before = room.gameplayToken;

    advanceTurnOnTimeout(makeFakeIo().io, ROOM_ID);

    expect(room.gameplayToken).not.toBe(before);
  });

  it('rotates for an authoritative roster removal', () => {
    const room = makePlayingRoom();
    room.state.players.splice(0, 1);
    const before = room.gameplayToken;

    handleActivePlayerRemoved(room, 0);

    expect(room.gameplayToken).not.toBe(before);
  });

  it('leaves token and state unchanged when a valid-base push is stale', () => {
    const room = makePlayingRoom();
    const pushState = registerPush();
    const firstAck = vi.fn();
    pushState({ roomId: ROOM_ID, newState: { round: 2 }, base: BASE_TOKEN, mutationId: NEXT_TOKEN }, firstAck);
    const tokenAfterFirstPush = room.gameplayToken;
    const roundAfterFirstPush = room.state.round;
    const staleAck = vi.fn();

    pushState({ roomId: ROOM_ID, newState: { round: 99 }, base: BASE_TOKEN, mutationId: OTHER_TOKEN }, staleAck);

    expect(firstAck).toHaveBeenCalledWith({ ok: true, stateVersion: 1, gameplayToken: NEXT_TOKEN });
    expect(staleAck).toHaveBeenCalledWith({ ok: false, reason: 'stale-base' });
    expect(room.gameplayToken).toBe(tokenAfterFirstPush);
    expect(room.state.round).toBe(roundAfterFirstPush);
  });

  it('rejects a stale pre-rematch push even when round and seat repeat', () => {
    const room = makePlayingRoom();
    room.state.status = 'playing';
    room.state.finished = true;
    room.state.currentPlayerIndex = null;
    const pushState = registerPush(HOST_SOCKET, 'Bob');
    const rematchAck = vi.fn();

    pushState({
      roomId: ROOM_ID,
      newState: { status: 'playing', finished: false, currentPlayerIndex: 0, round: 1 },
      base: BASE_TOKEN,
      mutationId: NEXT_TOKEN,
    }, rematchAck);
    const rematchToken = room.gameplayToken;
    const staleAck = vi.fn();

    pushState({
      roomId: ROOM_ID,
      newState: { currentPlayerIndex: 0, round: 1 },
      base: BASE_TOKEN,
      mutationId: OTHER_TOKEN,
    }, staleAck);

    expect(rematchAck).toHaveBeenCalledWith({ ok: true, stateVersion: 1, gameplayToken: NEXT_TOKEN });
    expect(staleAck).toHaveBeenCalledWith({ ok: false, reason: 'stale-base' });
    expect(room.gameplayToken).toBe(rematchToken);
    expect(room.state.round).toBe(1);
    expect(room.state.currentPlayerIndex).toBe(0);
  });
});
