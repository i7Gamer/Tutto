/**
 * @vitest-environment node
 *
 * The env-override guard behind the operational limits (SOCKET_CONN_LIMIT_MAX,
 * MAX_ROOMS_PER_ADDRESS).
 *
 * This exists because vite.config.ts pins BOTH of those vars to 1000000 for
 * every suite, so no other test can reach the fallback — and the fallback is
 * the production path: in a normal deployment the vars are unset, which makes
 * `Number(undefined)` NaN. Without the guard the connection limiter compares
 * `count <= NaN`, which is always false, and every socket after the first is
 * refused. Testing the rule directly is the only way to cover it without
 * unpinning the vars for every other suite.
 */
import { describe, it, expect } from 'vitest';
import { envLimitOr } from './envLimits';

const FALLBACK = 20;

describe('envLimitOr', () => {
  it('takes a positive numeric override', () => {
    expect(envLimitOr('5', FALLBACK)).toBe(5);
    expect(envLimitOr('1000000', FALLBACK)).toBe(1_000_000);
  });

  it('falls back when the variable is unset, which is the production case', () => {
    // Number(undefined) is NaN, and NaN comparisons are always false — the
    // failure mode is not "the limit is huge", it is "nothing is ever allowed".
    expect(envLimitOr(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'twenty'],
    ['zero', '0'],
    ['negative', '-5'],
    ['infinite', 'Infinity'],
  ])('falls back on a %s value rather than arming a limit nothing can satisfy', (_label, raw) => {
    expect(envLimitOr(raw, FALLBACK)).toBe(FALLBACK);
  });

  it('accepts a fractional override rather than rejecting it', () => {
    // Not a shape any operator would set deliberately, but it is a usable
    // limit and rounding it here would hide the typo rather than honour it.
    expect(envLimitOr('2.5', FALLBACK)).toBe(2.5);
  });
});
