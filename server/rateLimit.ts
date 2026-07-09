import type express from 'express';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  // Upper bound on distinct keys tracked at once, before a request opportunistically
  // sweeps expired entries out of the map. Without this, a flood of one-off requests
  // from many different IPs would grow the map forever — each key only ever gets
  // cleaned up when a fresh request happens to land after its window expired.
  maxTrackedKeys?: number;
}

interface Hit {
  count: number;
  resetAt: number;
}

// A minimal fixed-window rate limiter keyed by client IP. Not shared across
// server instances/processes — fine for this app's single-process deployment,
// and simpler than pulling in a dependency for one low-traffic endpoint.
export const createRateLimiter = ({ windowMs, max, maxTrackedKeys = 10_000 }: RateLimiterOptions) => {
  const hits = new Map<string, Hit>();

  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();

    if (hits.size > maxTrackedKeys) {
      let expiredAny = false;
      for (const [k, hit] of hits) {
        if (hit.resetAt <= now) {
          hits.delete(k);
          expiredAny = true;
        }
      }
      // Nothing expired yet (e.g. many distinct keys within one window) — the
      // cap must still be enforced, so fall back to evicting the oldest
      // entries. Map iteration order is insertion order, so the first keys
      // yielded are the oldest.
      if (!expiredAny) {
        const excess = hits.size - maxTrackedKeys;
        const oldestKeys = hits.keys();
        for (let i = 0; i < excess; i++) {
          const oldest = oldestKeys.next().value;
          if (oldest === undefined) break;
          hits.delete(oldest);
        }
      }
    }

    const existing = hits.get(key);
    if (!existing || existing.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    existing.count += 1;
    next();
  };
};

export interface SocketEventLimiterOptions {
  windowMs: number;
  max: number;
}

// A fixed-window limiter scoped to a single call site's own closure — meant
// to be instantiated once per Socket.IO connection, one instance per event
// name. Unlike createRateLimiter's per-IP Map (built for HTTP, where many
// clients share one middleware instance), a socket event handler already
// runs inside a per-connection closure, so a plain counter is enough: no
// keying or eviction bookkeeping needed.
export const createSocketEventLimiter = ({ windowMs, max }: SocketEventLimiterOptions) => {
  let count = 0;
  let resetAt = 0;

  return (): boolean => {
    const now = Date.now();
    if (now >= resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
    count += 1;
    return count <= max;
  };
};
