import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import { createRateLimiter } from './rateLimit';
import { DEV_DEFAULT_API_TOKEN, validateApiTokenForStartup } from './startupGuards';

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
const STATS_RATE_LIMIT_MAX = 60;

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
    console.error(
      `[client-error] ${field('timestamp') || new Date().toISOString()} ${field('message')}\n` +
      `stack: ${field('stack')}\ncomponentStack: ${field('componentStack')}`
    );
    res.json({ success: true });
  });

  app.get('/api/stats/global', statsRateLimiter, async (_req: express.Request, res: express.Response) => {
    try {
      const stats = await getGlobalStats();
      res.json(stats ?? {});
    } catch (err) {
      console.error('DB error in global GET:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/stats/global', requireToken, async (req: express.Request, res: express.Response) => {
    try {
      await updateGlobalStats(sanitizeStats(req.body));
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.get('/api/stats/:deviceId', statsRateLimiter, async (req: express.Request, res: express.Response) => {
    try {
      const stats = await getDeviceStats(req.params.deviceId as string);
      res.json(stats ?? {});
    } catch (err) {
      console.error('DB error in device GET:', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  app.post('/api/stats/:deviceId', requireToken, async (req: express.Request, res: express.Response) => {
    try {
      await updateDeviceStats(req.params.deviceId as string, sanitizeStats(req.body));
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // SPA fallback — must be registered last so it doesn't shadow the API routes.
  app.use((_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'), (err: Error | null) => {
      if (err) res.status(404).send('Not found');
    });
  });
};
