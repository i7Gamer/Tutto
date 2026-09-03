/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { createRateLimiter, createSocketEventLimiter, createKeyedEventLimiter } from './rateLimit';

const makeReq = (ip: string): { ip: string } => ({ ip });

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
};

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls next() for requests within the limit', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    const next = vi.fn();
    const res = makeRes();

    limiter(makeReq('1.2.3.4') as never, res as never, next);
    limiter(makeReq('1.2.3.4') as never, res as never, next);
    limiter(makeReq('1.2.3.4') as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(200);
  });

  it('responds 429 once the limit is exceeded within the window', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    const next = vi.fn();
    const res = makeRes();

    limiter(makeReq('1.2.3.4') as never, res as never, next);
    limiter(makeReq('1.2.3.4') as never, res as never, next);
    limiter(makeReq('1.2.3.4') as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
  });

  it('sets Retry-After to the remaining window time on a 429 (RL-2)', () => {
    const limiter = createRateLimiter({ windowMs: 5000, max: 1 });
    const next = vi.fn();
    const res = makeRes();

    limiter(makeReq('1.2.3.4') as never, res as never, next);
    vi.advanceTimersByTime(3000); // 2000ms left in the window
    limiter(makeReq('1.2.3.4') as never, res as never, next);

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('2');
  });

  it('tracks each key independently', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const next = vi.fn();
    const resA = makeRes();
    const resB = makeRes();

    limiter(makeReq('1.1.1.1') as never, resA as never, next);
    limiter(makeReq('2.2.2.2') as never, resB as never, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
  });

  it('resets the count once the window elapses', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const next = vi.fn();
    const res = makeRes();

    limiter(makeReq('1.2.3.4') as never, res as never, next);
    limiter(makeReq('1.2.3.4') as never, res as never, next);
    expect(res.statusCode).toBe(429);

    vi.advanceTimersByTime(1001);

    const res2 = makeRes();
    limiter(makeReq('1.2.3.4') as never, res2 as never, next);
    expect(res2.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keys hits with a custom keyFn instead of req.ip', () => {
    // A caller may want to key by something other than the request's IP
    // (e.g. a validated id from a header) so unrelated callers sharing one
    // IP don't share one bucket.
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 1,
      keyFn: (req: express.Request) => (req as unknown as { deviceId: string }).deviceId,
    });
    const next = vi.fn();
    const resA = makeRes();
    const resB = makeRes();

    limiter({ ip: '1.2.3.4', deviceId: 'device-a' } as never, resA as never, next);
    limiter({ ip: '1.2.3.4', deviceId: 'device-b' } as never, resB as never, next);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
  });

  it('shares a bucket across two requests with the same keyFn result even from different IPs', () => {
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 1,
      keyFn: (req: express.Request) => (req as unknown as { deviceId: string }).deviceId,
    });
    const next = vi.fn();
    const res1 = makeRes();
    const res2 = makeRes();

    limiter({ ip: '1.1.1.1', deviceId: 'device-a' } as never, res1 as never, next);
    limiter({ ip: '2.2.2.2', deviceId: 'device-a' } as never, res2 as never, next);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(429);
  });

  it('falls back to a shared key when req.ip is missing', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const next = vi.fn();
    const res1 = makeRes();
    const res2 = makeRes();

    limiter({} as never, res1 as never, next);
    limiter({} as never, res2 as never, next);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(429);
  });

  it('sweeps expired entries once the tracked-key cap is exceeded', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, maxTrackedKeys: 2 });
    const next = vi.fn();

    limiter(makeReq('a') as never, makeRes() as never, next);
    limiter(makeReq('b') as never, makeRes() as never, next);

    vi.advanceTimersByTime(1001); // both entries above are now expired

    // Map is now at size 2 (== maxTrackedKeys, not yet over it), so adding 'c'
    // doesn't sweep — it lands at size 3, one past the threshold.
    limiter(makeReq('c') as never, makeRes() as never, next);

    // This request crosses the threshold (size 3 > 2), triggering a sweep
    // before it's processed — 'a' and 'b' get pruned since they're expired
    // ('c' is fresh and survives). With 'a' pruned, this request for it is
    // treated as new rather than blocked by a stale entry.
    const res = makeRes();
    limiter(makeReq('a') as never, res as never, next);
    expect(res.statusCode).toBe(200);
  });

  it('evicts the oldest entries once the tracked-key cap is exceeded even if nothing has expired yet', () => {
    // A long window means the sweep-on-expiry path never fires; the cap must
    // still be enforced by falling back to evicting the oldest entries.
    const limiter = createRateLimiter({ windowMs: 100_000, max: 1, maxTrackedKeys: 2 });
    const next = vi.fn();

    limiter(makeReq('a') as never, makeRes() as never, next); // size 1
    limiter(makeReq('b') as never, makeRes() as never, next); // size 2 (== cap, no sweep yet)
    limiter(makeReq('c') as never, makeRes() as never, next); // size 3 (> cap on next request)

    // This request pushes the map over the cap with nothing expired, so the
    // oldest entry ('a') should be evicted before this request is processed —
    // meaning it's treated as a fresh key rather than blocked by its stale hit.
    const resA = makeRes();
    limiter(makeReq('a') as never, resA as never, next);
    expect(resA.statusCode).toBe(200);
  });
});

describe('createSocketEventLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls within the limit', () => {
    const allow = createSocketEventLimiter({ windowMs: 1000, max: 3 });
    expect(allow()).toBe(true);
    expect(allow()).toBe(true);
    expect(allow()).toBe(true);
  });

  it('rejects once the limit is exceeded within the window', () => {
    const allow = createSocketEventLimiter({ windowMs: 1000, max: 2 });
    expect(allow()).toBe(true);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    expect(allow()).toBe(false);
  });

  it('resets the count once the window elapses', () => {
    const allow = createSocketEventLimiter({ windowMs: 1000, max: 1 });
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(allow()).toBe(true);
  });

  it('tracks each limiter instance independently', () => {
    const allowA = createSocketEventLimiter({ windowMs: 1000, max: 1 });
    const allowB = createSocketEventLimiter({ windowMs: 1000, max: 1 });

    expect(allowA()).toBe(true);
    expect(allowA()).toBe(false);
    expect(allowB()).toBe(true);
  });
});

describe('createKeyedEventLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls within the limit for a key', () => {
    const allow = createKeyedEventLimiter({ windowMs: 1000, max: 2 });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(true);
  });

  it('rejects a key once its limit is exceeded within the window', () => {
    const allow = createKeyedEventLimiter({ windowMs: 1000, max: 2 });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);
    expect(allow('a')).toBe(false);
  });

  it('tracks each key independently', () => {
    const allow = createKeyedEventLimiter({ windowMs: 1000, max: 1 });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);
    expect(allow('b')).toBe(true);
  });

  it('resets a key once its window elapses', () => {
    const allow = createKeyedEventLimiter({ windowMs: 1000, max: 1 });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(allow('a')).toBe(true);
  });

  it('sweeps expired entries once the tracked-key cap is exceeded', () => {
    const allow = createKeyedEventLimiter({ windowMs: 1000, max: 1, maxTrackedKeys: 2 });

    allow('a');
    allow('b');

    vi.advanceTimersByTime(1001); // both entries above are now expired

    // Size 2 == cap (not over it) — no sweep yet; 'c' lands at size 3.
    allow('c');

    // This call crosses the threshold, sweeping the expired 'a'/'b' first —
    // so 'a' is treated as fresh instead of blocked by its stale entry.
    expect(allow('a')).toBe(true);
  });

  it('evicts the oldest entries once the cap is exceeded even if nothing has expired yet', () => {
    const allow = createKeyedEventLimiter({ windowMs: 100_000, max: 1, maxTrackedKeys: 2 });

    allow('a'); // size 1
    allow('b'); // size 2 (== cap, no sweep yet)
    allow('c'); // size 3 (> cap on next call)

    // Nothing expired, so the oldest entry ('a') is evicted before this call —
    // it is treated as a fresh key rather than blocked by its stale hit.
    expect(allow('a')).toBe(true);
  });
});
