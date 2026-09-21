import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../utils/onlineProtocol';

export type OnlineClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// The single client socket connection. It lives outside the zustand store
// (a live socket is not serializable state) and behind accessors so every
// slice talks to the same connection.
let socket: OnlineClientSocket | null = null;

export const getSocket = (): OnlineClientSocket | null => socket;
export const setSocket = (s: OnlineClientSocket): void => { socket = s; };
export const disconnectSocket = (): void => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
