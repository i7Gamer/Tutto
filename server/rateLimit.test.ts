import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from './rateLimit';

const makeReq = (ip: string): { ip: string } => ({ ip });

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
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
});
