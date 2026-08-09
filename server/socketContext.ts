import { Server, Socket } from 'socket.io';

/**
 * What a connection remembers about itself between events.
 *
 * Mutable, and shared by every handler registered for that connection: joining
 * writes it, leaving and disconnecting clear it, and the handlers that act on
 * "the room this socket is actually seated in" (sendReaction, kickPlayer,
 * endGameStats) read it rather than trusting a client-supplied roomId. It used
 * to be two `let`s in the connection closure, which is why every handler had to
 * live in that closure too.
 */
export interface ConnectionSession {
  roomId: string | null;
  username: string | null;
}

/** Everything a group of handlers needs to register itself for one connection. */
export interface SocketContext {
  io: Server;
  socket: Socket;
  session: ConnectionSession;
}

/**
 * Registers a listener that cannot take the process down.
 *
 * Every listener is registered through this instead of socket.on. A handler
 * that throws — or, for the async ones, returns a rejecting promise — must
 * never escape into the runtime: socket.io dispatches listeners from a bare
 * process.nextTick, so a synchronous throw is an uncaught exception with no
 * caller to catch it, and index.ts deliberately turns an unhandled rejection
 * into process.exit(1). Either route ends the process — every room, every
 * player — over one malformed event from one client (see the reorderPlayers
 * entry check for a case that really did). Containment is per-event: log it,
 * drop that event, keep serving. The two timer callbacks (advanceTurnOnTimeout,
 * the reconnect timeout in the room handlers) carry their own try/catch for the
 * same reason — they run off setTimeout, not socket.io.
 */
export const safeOn = <A extends unknown[]>(
  socket: Socket,
  event: string,
  handler: (...args: A) => unknown,
): void => {
  socket.on(event, (...args: unknown[]) => {
    try {
      const result = handler(...(args as A));
      if (result instanceof Promise) {
        result.catch((err: unknown) => console.error(`[socket:${event}] handler rejected:`, err));
      }
    } catch (err) {
      console.error(`[socket:${event}] handler threw:`, err);
    }
  });
};
