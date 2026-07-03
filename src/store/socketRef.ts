import type { Socket } from 'socket.io-client';

// The single client socket connection. It lives outside the zustand store
// (a live socket is not serializable state) and behind accessors so every
// slice talks to the same connection.
let socket: Socket | null = null;

export const getSocket = (): Socket | null => socket;
export const setSocket = (s: Socket): void => { socket = s; };
export const disconnectSocket = (): void => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
