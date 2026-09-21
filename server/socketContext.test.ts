/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeOn, type OnlineServerSocket } from './socketContext';
import { makeFakeIo, makeFakeSocket } from './socketTestHarness';
import type { DisconnectReason } from 'socket.io';
import type { PushStateAck, StatsSubmitAck } from '../src/types';

afterEach(() => vi.restoreAllMocks());

describe('safe socket event containment', () => {
  it('passes event arguments through and contains a synchronous throw', () => {
    const fake = makeFakeSocket('safe');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('sync failure');
    const handler = vi.fn(() => { throw failure; });
    safeOn(fake.socket, 'sendReaction', handler);
    const payload = { emoji: '🎲' };
    expect(() => fake.handlers.sendReaction(payload)).not.toThrow();
    expect(handler).toHaveBeenCalledWith(payload);
    expect(log).toHaveBeenCalledWith('[socket:sendReaction] handler threw:', failure);
  });

  it('returns a settled signal covering every await and catches rejection', async () => {
    const fake = makeFakeSocket('safe');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('async failure');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    safeOn(fake.socket, 'leaveRoom', async () => {
      await pending;
      await Promise.resolve();
      throw failure;
    });
    const result = fake.handlers.leaveRoom();
    expect(result).toBeInstanceOf(Promise);
    expect(log).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[socket:leaveRoom] handler rejected:', failure);
  });

  it('accepts successful synchronous and asynchronous handlers', async () => {
    const fake = makeFakeSocket('safe');
    safeOn(fake.socket, 'leaveRoom', () => undefined);
    safeOn(fake.socket, 'disconnect', async () => undefined);
    expect(fake.handlers.leaveRoom()).toBeUndefined();
    await expect(fake.handlers.disconnect('transport close')).resolves.toBeUndefined();
  });

  it('registers through the socket receiver so real Socket.IO sockets keep their binding', () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const socket = {
      id: 'receiver-sensitive',
      on(this: { id: string }, event: string, listener: (...args: unknown[]) => unknown) {
        expect(this.id).toBe('receiver-sensitive');
        handlers[event] = listener;
        return this;
      },
    } as unknown as OnlineServerSocket;

    const handler = vi.fn();
    safeOn(socket, 'leaveRoom', handler);

    expect(handlers.leaveRoom()).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });
});

const compileSafeOnProtocol = (): void => {
  const fake = makeFakeSocket('safe-types');

  safeOn(fake.socket, 'disconnect', () => undefined);
  safeOn(fake.socket, 'disconnect', (_reason: DisconnectReason) => undefined);
  safeOn(fake.socket, 'pushState', (
    _data: { roomId?: string; newState?: Record<string, unknown>; base?: unknown; mutationId?: unknown; action?: unknown } | null | undefined,
    _ack?: (result: PushStateAck) => void,
  ) => undefined);
  safeOn(fake.socket, 'endGameStats', (
    _data: { deviceId?: string; stats?: unknown; finishedGameToken?: string } | null | undefined,
    _ack?: (result: StatsSubmitAck) => void,
  ) => undefined);

  // @ts-expect-error server ingress event names are finite.
  safeOn(fake.socket, 'pushSatte', () => undefined);
  // @ts-expect-error pushState handlers receive the raw ingress object plus optional ack.
  safeOn(fake.socket, 'pushState', (_payload: number) => undefined);
  // @ts-expect-error disconnect handlers receive the Socket.IO disconnect reason.
  safeOn(fake.socket, 'disconnect', (_reason: number) => undefined);
  // @ts-expect-error kickPlayer receives untrusted input until its runtime guard narrows it.
  safeOn(fake.socket, 'kickPlayer', (_targetSocketId: string) => undefined);
};

void compileSafeOnProtocol;

const compileServerOutboundProtocol = (): void => {
  const { io } = makeFakeIo();
  const { socket } = makeFakeSocket('safe-outbound');

  io.to('room:ROOM').emit('gameState', { stateVersion: 1, gameplayToken: 'token' });
  io.to('room:ROOM').emit('hostId', 'host-socket');
  io.to('room:ROOM').emit('hostId', null);
  io.to('room:ROOM').emit('playerDisconnected', null);
  socket.emit('gameState', { stateRequestId: 'request-id' });
  socket.emit('hostId', 'host-socket');

  // @ts-expect-error server-to-client event names are finite.
  io.to('room:ROOM').emit('hostID', 'host-socket');
  // @ts-expect-error hostId broadcasts a nullable socket id, not a number.
  io.to('room:ROOM').emit('hostId', 1);
  // @ts-expect-error playerDisconnected broadcasts the nullable player name string.
  socket.emit('playerDisconnected', { name: 'Alice' });
};

void compileServerOutboundProtocol;
