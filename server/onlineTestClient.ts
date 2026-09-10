import { randomUUID } from 'node:crypto';
import { io, type Socket, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { ONLINE_PROTOCOL_VERSION } from '../src/utils/onlineProtocol';
import type { OnlineGameAction, PushStateAck } from '../src/types';
import type { RoomState } from './roomTypes';
import { connected, type JoinAck } from './socketTestHarness';

export type PublicTestState = Partial<RoomState> & { gameplayToken: string; finishedGameToken?: string | null; turnTimeRemaining?: number };

const latestStates = new WeakMap<Socket, PublicTestState>();
const observedSockets = new WeakSet<Socket>();
const observe = (socket: Socket): void => {
  if (observedSockets.has(socket)) return;
  observedSockets.add(socket);
  socket.on('gameState', (state: PublicTestState) => latestStates.set(socket, state));
};
export const protocolClient = (url: string, options: Partial<ManagerOptions & SocketOptions> = {}): Socket => {
  const socket = io(url, { ...options, auth: { protocolVersion: ONLINE_PROTOCOL_VERSION, ...options.auth } });
  observe(socket);
  return socket;
};

const waitPublicState = (socket: Socket, matches: (state: PublicTestState) => boolean): Promise<PublicTestState> => {
  observe(socket);
  const latest = latestStates.get(socket);
  if (latest && matches(latest)) return Promise.resolve(latest);
  return new Promise(resolve => {
    const receive = (state: PublicTestState) => {
      if (!matches(state)) return;
      socket.off('gameState', receive);
      resolve(state);
    };
    socket.on('gameState', receive);
  });
};

export const requestPublicState = (socket: Socket, roomId: string,
  matches: (state: PublicTestState) => boolean = () => true): Promise<PublicTestState> =>
  new Promise(resolve => {
    observe(socket);
    const receive = (state: PublicTestState) => {
      if (!matches(state)) return;
      socket.off('gameState', receive);
      resolve(state);
    };
    socket.on('gameState', receive);
    socket.emit('requestState', { roomId });
  });

export const joinTestRoom = async (socket: Socket, roomId: string, name: string,
  initialConfig?: Record<string, unknown>): Promise<PublicTestState> => {
  await connected(socket);
  const ack = await new Promise<JoinAck>(resolve => socket.emit('joinRoom', {
    roomId, name, deviceId: `dev-${roomId}-${name}`, initialConfig,
  }, resolve));
  if (!ack.success) throw new Error(`Join failed: ${ack.error}`);
  return waitPublicState(socket, state => state.players?.some(player => player.name === name) === true);
};

/** An honest v2 command, never a snapshot-to-command compatibility adapter. */
export const pushOnlineAction = async (socket: Socket, roomId: string, action: OnlineGameAction,
  newState: Record<string, unknown> = {}): Promise<PushStateAck> => {
  observe(socket);
  const state = latestStates.get(socket) ?? await requestPublicState(socket, roomId);
  const send = (base: string): Promise<PushStateAck> => new Promise(resolve => socket.emit('pushState', {
    roomId, base, mutationId: randomUUID(), action, newState,
  }, resolve));
  const ack = await send(state.gameplayToken);
  // A different client's accepted action may not have reached this observer
  // yet. Retry only a proven non-mutating stale-base refusal, never silence.
  if (!ack.ok && ack.reason === 'stale-base') {
    const fresh = await requestPublicState(socket, roomId);
    return send(fresh.gameplayToken);
  }
  return ack;
};

export const acceptOnlineAction = async (socket: Socket, roomId: string, action: OnlineGameAction,
  newState: Record<string, unknown> = {}): Promise<PublicTestState> => {
  const ack = await pushOnlineAction(socket, roomId, action, newState);
  if (!ack.ok) throw new Error(`Action ${action.type} refused: ${ack.reason}`);
  return waitPublicState(socket, state => state.gameplayToken === ack.gameplayToken);
};

export const configureTestRoom = (socket: Socket, roomId: string, config: Record<string, unknown>): Promise<PublicTestState> => {
  const received = waitPublicState(socket, state => Object.entries(config).every(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).every(([field, expected]) =>
        (state[key as keyof PublicTestState] as Record<string, unknown> | undefined)?.[field] === expected)
      : state[key as keyof PublicTestState] === value));
  socket.emit('updateConfig', { roomId, ...config });
  return received;
};
