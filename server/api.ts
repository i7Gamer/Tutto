import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats, sanitizeLogHeaderField, indentLogContinuationLines } from './sanitize';
import { createRateLimiter } from './rateLimit';
import { envLimitOr } from './envLimits';
import { DEV_DEFAULT_API_TOKEN, validateApiTokenForStartup } from './startupGuards';
import { DEFAULT_GAME_MODE, GAME_MODES, type GameMode, type Ruleset } from '../src/types';
import { DEFAULT_RULESET, isValidRuleset, RULESETS, MAX_DEVICE_ID_LENGTH } from '../src/utils/configValidation';
import { DEVICE_ID_HEADER, DEVICE_STATS_PATH } from '../src/utils/statsApi';

// Client crash reports from the ErrorBoundary (see src/utils/crashLog.ts).
// Unauthenticated by design — crash reporting must work for any player — so
// the payload is strictly truncated and only ever logged, never stored or
// echoed back. express.json() already caps the body size at its default limit.
// Rate-limited per IP (below) since it's otherwise an open, unauthenticated
// write endpoint — without a cap, a scripted client could flood the server
// log (or a slow disk/log shipper) with an unbounded number of requests.
const CRASH_FIELD_MAX = 2000;
const CRASH_LOG_RATE_LIMIT_WINDOW_MS = 60_000;
const CRASH_LOG_RATE_LIMIT_MAX = 20;

const STATS_RATE_LIMIT_WINDOW_MS = 60_000;
// Overridable for spawned test servers (see socketTestHarness.ts and
// vite.config.ts): a suite that polls /api/stats must not 429 itself. Unset in
// production, so the default stands there.
const STATS_RATE_LIMIT_MAX = envLimitOr(process.env.STATS_RATE_LIMIT_MAX, 60);

// How a client walking away mid-response reaches an express callback: the
// player hit stop or reload, or the connection dropped, while a file was
// streaming. Not an error anyone can be told about — see the SPA fallback.
const CLIENT_ABORT_ERROR_CODES = ['ECONNABORTED', 'ECONNRESET'];

const isClientAbort = (err: unknown): boolean =>
  CLIENT_ABORT_ERROR_CODES.includes((err as { code?: string }).code ?? '');

// Reads env at call time (not import time) so it runs after index.ts has
// loaded .env via dotenv — module bodies are hoisted above that statement.
export const registerApiRoutes = (app: express.Express): void => {
  // API_TOKEN guards the HTTP POST /api/stats/* endpoints (admin/tool access only).
  // Clients submit stats via authenticated WebSocket events — no token in the
  // client bundle. Deliberately NOT prefixed with VITE_: Vite compiles any
  // referenced VITE_* env var into the public bundle, so the prefix would turn
  // one careless import.meta.env reference into a leaked server secret.
  const apiTokenError = validateApiTokenForStartup(process.env);
  if (apiTokenError) {
    console.error(apiTokenError);
    process.exit(1);
  }
  const API_TOKEN = process.env.API_TOKEN || DEV_DEFAULT_API_TOKEN;
  const expectedTokenBuffer = Buffer.from(API_TOKEN);

  // Constant-time comparison — a plain !== leaks the token character-by-character
  // via response-timing, since string comparison short-circuits at the first
  // mismatched byte.
  const isValidToken = (supplied: unknown): boolean => {
    if (typeof supplied !== 'string') return false;
    const suppliedBuffer = Buffer.from(supplied);
    if (suppliedBuffer.length !== expectedTokenBuffer.length) return false;
    return crypto.timingSafeEqual(suppliedBuffer, expectedTokenBuffer);
  };

  const requireToken = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    if (!isValidToken(req.headers['x-tutto-token'])) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };

  const isValidDeviceId = (deviceId: unknown): deviceId is string =>
    typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length <= MAX_DEVICE_ID_LENGTH;

  const requireValidDeviceId = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    if (!isValidDeviceId(req.params.deviceId)) {
      res.status(400).json({ error: 'Invalid device id' });
      return;
    }
    next();
  };

  // The device id a read carries, decoded back to the raw value the database
  // and the socket path both key on — or null when the header is missing,
  // unusable or over the cap, which the caller answers exactly as an unusable
  // path param is answered. The client percent-encodes it (see
  // deviceStatsRequest) because a header value may only carry visible ASCII,
  // so the cap is measured after decoding.
  const deviceIdFromHeader = (req: express.Request): string | null => {
    const escaped = req.header(DEVICE_ID_HEADER);
    if (typeof escaped !== 'string') return null;
    let deviceId: string;
    try {
      deviceId = decodeURIComponent(escaped);
    } catch {
      // A malformed escape ('%zz'). Express rejects one in a path param with a
      // 400 of its own; letting decodeURIComponent throw here would raise a 500.
      return null;
    }
    return isValidDeviceId(deviceId) ? deviceId : null;
  };

  // Which statistics bucket a request means. Anything unrecognised — absent
  // (every client older than the split), empty, an array from a repeated
  // parameter — reads as the normalized one rather than becoming a third
  // bucket that could be written but never read back.
  const requestedMode = (req: express.Request): GameMode =>
    GAME_MODES.find(mode => mode === req.query.mode) ?? DEFAULT_GAME_MODE;

  // Which global-statistics row a request means — same fallback rule as the
  // device mode above: anything unrecognised reads as the modernized row.
  const requestedRuleset = (req: express.Request): Ruleset =>
    isValidRuleset(req.query.ruleset) ? req.query.ruleset : DEFAULT_RULESET;

  /**
   * Refuses a WRITE that names a bucket which does not exist.
   *
   * The two readers above fall back to the default bucket for anything
   * unrecognised, which is the only answer a read can give. A write cannot
   * afford it: the numbers land somewhere permanent, and answering
   * `success: true` after silently putting them in the default row is how a
   * single typo (`?mode=nomral`) corrupts the row it was never meant to
   * touch — invisibly, since the caller was told it worked.
   *
   * Absent stays the default, exactly as before: every client older than the
   * split sends no parameter at all. Present-but-empty is a mangled URL, not
   * an omission, so it is refused with the rest. The accepted values are
   * named in the answer, which is the whole point of failing loudly here.
   */
  const rejectUnknownBucket = (param: string, accepted: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const requested = req.query[param];
      if (requested === undefined || accepted.some(value => value === requested)) {
        next();
        return;
      }
      res.status(400).json({ error: `Unknown ${param} — accepted values: ${accepted.join(', ')}` });
    };

  const MODE_PARAM = 'mode';
  const RULESET_PARAM = 'ruleset';
  const rejectUnknownMode = rejectUnknownBucket(MODE_PARAM, GAME_MODES);
  const rejectUnknownRuleset = rejectUnknownBucket(RULESET_PARAM, RULESETS);

  /**
   * Refuses a WRITE that carries the OTHER route's bucket parameter.
   *
   * Each write route above only ever reads the one parameter it understands
   * — /api/stats/:deviceId reads `mode`, /api/stats/global reads `ruleset` —
   * so passing the wrong one is silently ignored and the write lands in the
   * default bucket. 'classic' is a value in both GAME_MODES and RULESETS,
   * which makes `?mode=classic` on the global route (or `?ruleset=classic` on
   * the device route) a highly plausible operator typo: it reads as though it
   * worked, `success: true` and all, while quietly corrupting the default row
   * instead of the one the caller meant.
   */
  const rejectForeignBucketParam = (acceptedParam: string, foreignParam: string) =>
    (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      if (req.query[foreignParam] === undefined) {
        next();
        return;
      }
      res.status(400).json({ error: `This route accepts ${acceptedParam}, not ${foreignParam}` });
    };

  const crashLogRateLimiter = createRateLimiter({
    windowMs: CRASH_LOG_RATE_LIMIT_WINDOW_MS,
    max: CRASH_LOG_RATE_LIMIT_MAX,
  });

  const statsRateLimiter = createRateLimiter({
    windowMs: STATS_RATE_LIMIT_WINDOW_MS,
    max: STATS_RATE_LIMIT_MAX,
  });

  app.post('/api/log/client-error', crashLogRateLimiter, (req: express.Request, res: express.Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const field = (key: string): string => String(body[key] ?? '').slice(0, CRASH_FIELD_MAX);
    // Header-line fields are newline-stripped and multi-line stack fields get
    // their continuation lines indented — otherwise a crafted report could
    // forge standalone "[client-error]" entries in the server log.
    const headerField = (key: string): string => sanitizeLogHeaderField(field(key));
    const blockField = (key: string): string => indentLogContinuationLines(field(key));
    console.error(
      `[client-error] ${headerField('timestamp') || new Date().toISOString()} ${headerField('message')}\n` +
      `stack: ${blockField('stack')}\ncomponentStack: ${blockField('componentStack')}`
    );
    res.json({ success: true });
  });

  // Liveness probe for the container HEALTHCHECK and any reverse proxy in
  // front of it. Deliberately does no database work and carries no rate
  // limiter: it is polled for the whole lifetime of the process, and a 429 or
  // a slow query here would get a healthy container restarted.
  app.get('/api/health', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/stats/global', statsRateLimiter, async (req: express.Request, res: express.Response) => {
    try {
      const stats = await getGlobalStats(requestedRuleset(req));
      res.json(stats ?? {});
    } catch (err) {
      console.error('DB error in global GET:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/stats/global', requireToken, rejectForeignBucketParam(RULESET_PARAM, MODE_PARAM), rejectUnknownRuleset, async (req: express.Request, res: express.Response) => {
    try {
      await updateGlobalStats(sanitizeStats(req.body), requestedRuleset(req));
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // One fixed path for every device, with the id in DEVICE_ID_HEADER: this is
  // the only unauthenticated route that names a device, and a path segment
  // would be written into every fronting proxy's access.log — where anyone
  // who can read logs would then hold the id that lets a client reclaim its
  // seat. No path-param fallback, or the leak would simply stay available.
  app.get(DEVICE_STATS_PATH, statsRateLimiter, async (req: express.Request, res: express.Response) => {
    const deviceId = deviceIdFromHeader(req);
    if (deviceId === null) {
      res.status(400).json({ error: 'Invalid device id' });
      return;
    }
    // Defence in depth for the header-based id above: moving it out of the path
    // made this URL identical for EVERY device, so the only thing distinguishing
    // two responses is a request header. Any shared cache in front of /api with
    // a positive TTL would hand one device's stats to the next caller. `Vary`
    // alone would not cover it — Cloudflare ignores Vary on most plans — so the
    // response is simply not storable.
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const stats = await getDeviceStats(deviceId, requestedMode(req));
      res.json(stats ?? {});
    } catch (err) {
      console.error('DB error in device GET:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/stats/:deviceId', requireToken, requireValidDeviceId, rejectForeignBucketParam(MODE_PARAM, RULESET_PARAM), rejectUnknownMode, async (req: express.Request, res: express.Response) => {
    try {
      await updateDeviceStats(req.params.deviceId as string, sanitizeStats(req.body), requestedMode(req));
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Any /api/* path that didn't match a route above is a typo'd or unknown
  // endpoint, not a client-side route — without this it fell through to the
  // SPA fallback below and got a 200 + index.html, masking client bugs (a
  // failed fetch silently "succeeding") and giving probes a misleading
  // response instead of a clear 404. Registered after every real route so it
  // only catches what nothing else did.
  app.use('/api', (_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // SPA fallback — must be registered last so it doesn't shadow the API routes.
  app.use((_req: express.Request, res: express.Response) => {
    // Left to contextual typing rather than annotated: express's Errback has
    // already changed shape once (Error | null -> Error | undefined, in
    // @types/express-serve-static-core 5.1.3) and broke the build.
    res.sendFile(path.join(__dirname, '../dist/index.html'), (err) => {
      if (!err) return;
      // An abort is not a missing file, and once the response has started
      // there is nothing that can be said anyway: answering again throws
      // ERR_HTTP_HEADERS_SENT out of this callback — uncaught, so a single
      // client reloading mid-download would take the server with it.
      if (res.headersSent || isClientAbort(err)) return;
      res.status(404).send('Not found');
    });
  });
};
