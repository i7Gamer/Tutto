import path from 'path';
import express from 'express';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';

// Client crash reports from the ErrorBoundary (see src/utils/crashLog.ts).
// Unauthenticated by design — crash reporting must work for any player — so
// the payload is strictly truncated and only ever logged, never stored or
// echoed back. express.json() already caps the body size at its default limit.
const CRASH_FIELD_MAX = 2000;

// Reads env at call time (not import time) so it runs after index.ts has
// loaded .env via dotenv — module bodies are hoisted above that statement.
export const registerApiRoutes = (app: express.Express): void => {
  // VITE_API_TOKEN guards the HTTP POST /api/stats/* endpoints (admin/tool access only).
  // Clients submit stats via authenticated WebSocket events — no token in the client bundle.
  if (process.env.NODE_ENV === 'production' && !process.env.VITE_API_TOKEN) {
    console.error('[SECURITY] VITE_API_TOKEN is not set. Refusing to start in production.');
    process.exit(1);
  }
  const API_TOKEN = process.env.VITE_API_TOKEN || 'tutto-local-dev-token';

  const requireToken = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    if (req.headers['x-tutto-token'] !== API_TOKEN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };

  app.post('/api/log/client-error', (req: express.Request, res: express.Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const field = (key: string): string => String(body[key] ?? '').slice(0, CRASH_FIELD_MAX);
    console.error(
      `[client-error] ${field('timestamp') || new Date().toISOString()} ${field('message')}\n` +
      `stack: ${field('stack')}\ncomponentStack: ${field('componentStack')}`
    );
    res.json({ success: true });
  });

  app.get('/api/stats/global', async (_req: express.Request, res: express.Response) => {
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

  app.get('/api/stats/:deviceId', async (req: express.Request, res: express.Response) => {
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
