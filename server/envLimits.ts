/**
 * The one rule for reading an operational limit that an operator MAY override.
 *
 * The fallback is not a nicety — it is the production path. These variables are
 * normally unset, so `Number(process.env.X)` is NaN, and a NaN limit does not
 * mean "unlimited": `count <= NaN` is false, so the connection limiter would
 * refuse every socket after the first. Junk, empty, zero and negative values
 * fall back for the same reason: a limit nothing can satisfy is worse than the
 * default it replaced.
 *
 * Named once so both call sites share it, and so it can be tested at all —
 * vite.config.ts pins SOCKET_CONN_LIMIT_MAX and MAX_ROOMS_PER_ADDRESS for every
 * suite, which puts the fallback out of reach of any test that goes through
 * them. scaledTimerMs (turnTimers.ts) applies the same shape to a different
 * quantity, and says so.
 */
export const envLimitOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
