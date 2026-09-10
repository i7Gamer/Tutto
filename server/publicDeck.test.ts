// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoom, deleteRoom, emitRoomState, emitRoomStateTo, rooms } from './rooms';
import { makeFakeIo, makeFakeSocket, makeServerPlayer } from './socketTestHarness';

const ROOM = 'PUBLIC-DECK';

afterEach(() => { deleteRoom(ROOM); });

describe('public room snapshots conceal the private deck', () => {
  it('withholds ordered cards on broadcasts and sender-only resync', () => {
    const room = rooms[ROOM] = createRoom('host');
    room.state.players = [makeServerPlayer('Alice')];
    room.state.currentCard = '300';
    room.state.cards = ['Stop', '200', 'Stop'];
    const { io, emit } = makeFakeIo();
    emitRoomState(io, ROOM);
    const payload = emit.mock.calls.find(([event]) => event === 'gameState')![1];
    expect(payload).not.toHaveProperty('cards');
    expect(payload.remainingCardCounts).toEqual({ Stop: 2, '200': 1 });
    expect(payload.currentCard).toBe('300');
    expect(room.state.cards).toEqual(['Stop', '200', 'Stop']);

    const fake = makeFakeSocket('guest');
    emitRoomStateTo(fake.socket, ROOM);
    expect(fake.socket.emit).toHaveBeenCalledWith('gameState', payload);
  });

  it('does not distinguish private permutations with the same public history', () => {
    const room = rooms[ROOM] = createRoom('host');
    const fake = makeFakeSocket('guest');
    room.state.cards = ['Stop', '200', 'Stop'];
    emitRoomStateTo(fake.socket, ROOM);
    room.state.cards = ['200', 'Stop', 'Stop'];
    emitRoomStateTo(fake.socket, ROOM);
    const calls = vi.mocked(fake.socket.emit).mock.calls.filter(([event]) => event === 'gameState');
    expect(JSON.stringify(calls[0][1])).toBe(JSON.stringify(calls[1][1]));
  });
});
