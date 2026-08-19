import path from 'path';
import dotenv from 'dotenv';
// quiet: true suppresses dotenv's startup banner, which is noise in a
// container where configuration arrives as real env vars and no .env exists.
dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true });

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerSocketHandlers } from './socketHandlers';
import { registerApiRoutes } from './api';
import { initDb, closeDb } from './database';
import { resolveCorsOrigin, validateCorsOriginForStartup, isProxyTrusted, warnIfProxyTrustUnset } from './startupGuards';
import { applyResponseHardening } from './securityHeaders';
import { resolveDbFilename } from './knexfile';
import { createShutdownHandler, createServerClosers, SHUTDOWN_SIGNALS } from './shutdown';
import { rooms } from './rooms';
import { summarizeActivity, renderActivityLine } from './activity';
import { createStatusLine, isStatusLineEnabled } from './statusLine';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection, shutting down:', reason);
  process.exit(1);
});

// An explicit wildcard in production would let any site make authenticated
// cross-origin requests against this server — mirrors the API_TOKEN
// production guard in api.ts. Runs before resolveCorsOrigin so a rejected
// value never reaches the middleware.
const corsOriginError = validateCorsOriginForStartup(process.env);
if (corsOriginError) {
  console.error(corsOriginError);
  process.exit(1);
}

// '*' outside production (local dev / LAN play), the explicit CORS_ORIGIN when
// one is set, and same-origin only in production when it is not.
const CORS_ORIGIN = resolveCorsOrigin(process.env);

const app = express();

// First, so it also covers the static files and the 404s express answers on
// its own. See securityHeaders.ts for what is set and what is deliberately not.
applyResponseHardening(app);

// Rate limiting (server/rateLimit.ts) keys requests by req.ip. Behind a
// reverse proxy that is meaningless unless Express is told to trust the
// proxy and read the client IP from X-Forwarded-For instead. Declared by
// the deployer (TRUST_PROXY=1), never inferred from NODE_ENV — a production
// build exposed directly must NOT trust the header, or any client could
// forge itself fresh rate-limit buckets (see isProxyTrusted).
if (isProxyTrusted()) {
  app.set('trust proxy', 1);
}
warnIfProxyTrustUnset();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  pingInterval: 4000,
  pingTimeout: 6000,
});

registerSocketHandlers(io);
registerApiRoutes(app);

const PORT = process.env.PORT || 3001;

// Whether a game is in progress, on one line rewritten in place at the bottom
// of this console — the answer to "may I close this window?", which nothing can
// give once the process holding `rooms` is gone. Opt-in (start-tutto-prod.bat
// sets TUTTO_STATUS_LINE), so containers and CI log exactly what they did
// before. null when it is not asked for: nothing is timed and console is left
// untouched.
const statusLine = isStatusLineEnabled(process.env)
  ? createStatusLine({
    render: () => renderActivityLine(summarizeActivity(rooms)),
    write: chunk => process.stdout.write(chunk),
    isTTY: Boolean(process.stdout.isTTY),
    hostConsole: console,
  })
  : null;

const start = async (): Promise<void> => {
  await initDb();
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Which database this is: development and production resolve to different
    // files unless DB_PATH says otherwise (see knexfile.ts), and finding that
    // out from a statistics screen that looks empty is far too late.
    console.log(`Statistics database: ${resolveDbFilename(process.env)}`);
    // After the startup lines, so it settles below them rather than being
    // scrolled past by them.
    statusLine?.start();
  });
};

// Started before the signal handlers are registered so `startup` exists for the
// closers below, and awaited by none of them for its value — only for the fact
// that migrations are no longer in flight. The catch replaces what the
// unhandledRejection handler above used to do for this promise.
const startup = start().catch((error: unknown) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

// io.close() disconnects every client and closes the HTTP server it is
// attached to, so the server is not closed separately — doing both would fail
// the second call with ERR_SERVER_NOT_RUNNING.
const shutdown = createShutdownHandler({
  closers: createServerClosers({
    closeSockets: done => io.close(done),
    closeDatabase: closeDb,
    startup,
  }),
  exit: code => process.exit(code),
});

// Registered outside start() on purpose: a `docker stop` during the migration
// window would otherwise find no handler at all and take the default
// disposition, killing the process mid-migration.
for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    // Before the shutdown log: it hands the console back and closes the line,
    // so the ordered-shutdown messages are not written over a sticky one.
    statusLine?.stop();
    void shutdown(signal);
  });
}
