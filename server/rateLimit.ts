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
      for (const [k, hit] of hits) {
        if (hit.resetAt <= now) hits.delete(k);
      }
    }

    const existing = hits.get(key);
    if (!existing || existing.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    existing.count += 1;
    next();
  };
};
