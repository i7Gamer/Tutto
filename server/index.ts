import path from 'path';
import dotenv from 'dotenv';
// quiet: true suppresses dotenv's startup banner, which is noise in a
// container where configuration arrives as real env vars and no .env exists.
// TUTTO_ENV_FILE relocates the file; the test harness points it at a path
// that does not exist so a spawned server never reads the checkout's own .env
// (see socketTestHarness.ts). Missing files are silently skipped by dotenv.
const ENV_FILE_VAR = 'TUTTO_ENV_FILE';
dotenv.config({ path: process.env[ENV_FILE_VAR] ?? path.join(__dirname, '../.env'), quiet: true });

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerSocketHandlers } from './socketHandlers';
import { registerApiRoutes } from './api';
import { initDb, closeDb } from './database';
import {
  resolveCorsOrigin, validateCorsOriginForStartup, isProxyTrusted, warnIfProxyTrustUnset,
  validatePortForStartup, resolvePortForStartup, describeListenError, type ErrnoException,
} from './startupGuards';
import { applyResponseHardening } from './securityHeaders';
import { resolveDbFilename } from './knexfile';
import { createShutdownHandler, createServerClosers, SHUTDOWN_SIGNALS } from './shutdown';
import { rooms } from './rooms';
import { summarizeActivity, renderActivityLine } from './activity';
import { createStatusLine, isStatusLineEnabled } from './statusLine';
import { MS_PER_SECOND } from '../src/utils/time';
import { MAX_PUSHED_STATE_BYTES } from './socketLimits';

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

const DIST_DIR = path.join(__dirname, '../dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

// Vite names every file under dist/assets/ by a hash of its content (see
// manualChunks in vite.config.ts) — the URL itself changes the instant the
// content does, so a client can never observe stale bytes at a given URL and
// there is nothing to ever revalidate. `immutable` tells a cache (and the
// browser) not to bother re-checking even on a hard refresh.
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const DAYS_PER_YEAR = 365;
const ASSET_CACHE_MAX_AGE_MS =
  DAYS_PER_YEAR * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

// Mounted before the catch-all dist static below so a request under
// /assets/ is answered here, with the immutable, long-lived cache — the
// catch-all's maxAge: 0 would otherwise apply to it too, since express.static
// matches whichever mount reaches a real file first.
app.use('/assets', express.static(ASSETS_DIR, {
  immutable: true,
  maxAge: ASSET_CACHE_MAX_AGE_MS,
  index: false,
}));
// Everything else under dist/ — index.html, the webmanifest, the icons,
// favicon.svg — keeps the same URL across a deploy even when its content
// changes, so it must always revalidate: maxAge: 0 rather than the assets'
// immutable year. `index` is left at its default ('index.html'), not set to
// `false`: without it express.static never matches a bare "/" at all (there
// is no file literally named ""), so the request would fall through to the
// SPA fallback in api.ts, which sendFile()s index.html with no Cache-Control
// of its own — silently losing the max-age: 0 this line exists to set. See
// "still answers max-age: 0 for the index route" in api.test.ts.
app.use(express.static(DIST_DIR, {
  maxAge: 0,
}));

const server = http.createServer(app);

// Without a listener here, Node's default behaviour for a 'error' event with
// none is to throw it and crash with a raw stack — EADDRINUSE (something
// else already bound this PORT) and EACCES (privileged port, or an OS
// policy) are both real deployment mistakes that deserve a one-line
// explanation instead.
server.on('error', (err: ErrnoException) => {
  console.error(describeListenError(err, PORT));
  process.exit(1);
});
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  pingInterval: 4000,
  pingTimeout: 6000,
  maxHttpBufferSize: MAX_PUSHED_STATE_BYTES,
});

registerSocketHandlers(io);
registerApiRoutes(app);

// Mirrors the CORS_ORIGIN guard above: junk PORT used to either crash with a
// raw stack (non-numeric) or silently bind an ephemeral port (PORT=0)
// instead of the one an operator asked for.
const portError = validatePortForStartup(process.env);
if (portError) {
  console.error(portError);
  process.exit(1);
}

const PORT = resolvePortForStartup(process.env);

// Whether a game is in progress, on one line rewritten in place at the bottom
// of this console — the answer to "may I close this window?", which nothing can
// give once the process holding `rooms` is gone. Opt-in (the production start
// script sets TUTTO_STATUS_LINE), so containers and CI log exactly what they did
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
