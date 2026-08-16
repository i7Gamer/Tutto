import { Server, Socket } from 'socket.io';
import { createKeyedEventLimiter } from './rateLimit';
import type { ConnectionSession, SocketContext } from './socketContext';
import { registerRoomHandlers } from './socketRoomHandlers';
import { registerConfigHandlers } from './socketConfigHandlers';
import { registerRosterHandlers } from './socketRosterHandlers';
import { registerReactionHandlers } from './socketReactionHandlers';
import { registerGameStateHandlers } from './socketGameStateHandlers';
import { registerStatsHandlers } from './socketStatsHandlers';
import { isProxyTrusted } from './startupGuards';

// New-connection budget per client address, shared across ALL connections.
// Every per-connection limiter lives in its connection's own closure, so a
// scripted client could reset all of them simply by reconnecting — this caps
// how often that trick can be pulled. Generous for real players (even a
// NAT'd household reconnecting after a router blip opens well under 30
// sockets in 10s). Max is env-tunable because the test suites legitimately
// open bursts of local connections far beyond any real client (see
// vite.config.ts test.env and playwright.config.ts webServer.env).
const CONNECTION_LIMIT = { windowMs: 10_000, max: 30 };

// socket.io has no trust-proxy support of its own: handshake.address is the
// raw peer address, which behind a reverse proxy is the proxy itself —
// keying the connection limiter on it would throttle all real users as one
// client. Mirror index.ts's `trust proxy: 1` (exactly one trusted hop) by
// using the rightmost X-Forwarded-For entry — the one appended by the
// trusted proxy — when the DEPLOYER declared that hop via TRUST_PROXY=1.
// Without the declaration XFF is ignored, so a directly-connecting client
// can't spoof its way into a fresh bucket (NODE_ENV says nothing about the
// topology — see isProxyTrusted). Exported for its unit tests.
export const getClientAddress = (socket: Socket): string => {
  if (isProxyTrusted()) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    const flat = Array.isArray(xff) ? xff.join(',') : xff;
    const rightmost = flat?.split(',').pop()?.trim();
    if (rightmost) return rightmost;
  }
  return socket.handshake.address ?? 'unknown';
};

// Every group of handlers gets the same context and registers its own
// listeners and its own per-connection rate limiters. Grouped by what they act
// on, which is also how the socket test suites are split (sockets.room,
// sockets.config, sockets.stats, ...). Order is not significant to socket.io
// dispatch; it is kept as it was for readability against the git history.
const REGISTRARS = [
  registerRoomHandlers,
  registerConfigHandlers,
  registerRosterHandlers,
  registerReactionHandlers,
  registerGameStateHandlers,
  registerStatsHandlers,
];

export const registerSocketHandlers = (io: Server): void => {
  const envConnLimitMax = Number(process.env.SOCKET_CONN_LIMIT_MAX);
  const connectionLimiter = createKeyedEventLimiter({
    windowMs: CONNECTION_LIMIT.windowMs,
    max: Number.isFinite(envConnLimitMax) && envConnLimitMax > 0 ? envConnLimitMax : CONNECTION_LIMIT.max,
  });

  io.use((socket, next) => {
    if (!connectionLimiter(getClientAddress(socket))) {
      next(new Error('Too many connections'));
      return;
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    // One per connection, shared by every handler registered below — see
    // ConnectionSession for why this is mutable state rather than a value.
    const session: ConnectionSession = { roomId: null, username: null };
    const context: SocketContext = { io, socket, session };

    for (const register of REGISTRARS) register(context);
  });
};
