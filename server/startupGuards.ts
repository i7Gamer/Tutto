// Pure validation logic for the production startup guards in index.ts/api.ts,
// split out so it can be unit-tested without spawning a real server
// subprocess (which is both slow and, under a parallel test run, a source of
// port-contention flakiness).

// Public-knowledge local-dev fallback for API_TOKEN — never valid in production.
export const DEV_DEFAULT_API_TOKEN = 'tutto-local-dev-token';

export const validateApiTokenForStartup = (
  env: { NODE_ENV?: string; API_TOKEN?: string },
): string | null => {
  if (env.NODE_ENV !== 'production') return null;
  if (!env.API_TOKEN) return '[SECURITY] API_TOKEN is not set. Refusing to start in production.';
  if (env.API_TOKEN === DEV_DEFAULT_API_TOKEN) {
    return '[SECURITY] API_TOKEN is set to the public local-dev default. Refusing to start in production.';
  }
  return null;
};

// Any origin. The dev/LAN-play default, and never a legal production value.
export const WILDCARD_CORS_ORIGIN = '*';

// Emit no cross-origin headers at all — the value both the cors middleware and
// Socket.IO understand as "same-origin requests only".
const SAME_ORIGIN_ONLY = false;

export const validateCorsOriginForStartup = (
  env: { NODE_ENV?: string; CORS_ORIGIN?: string },
): string | null => {
  if (env.NODE_ENV !== 'production') return null;
  if (env.CORS_ORIGIN === WILDCARD_CORS_ORIGIN) {
    return '[SECURITY] CORS_ORIGIN is explicitly "*", which would let any site make authenticated cross-origin requests. Refusing to start in production. Unset it for same-origin only, or set the deployed origin.';
  }
  return null;
};

// An unset CORS_ORIGIN used to mean "wildcard", which the guard above then
// refused — so a container started without configuration crash-looped. In
// production it now means same-origin only: strictly tighter than the wildcard
// the guard was protecting against, and correct for this app, whose frontend is
// served by this very server (see express.static in index.ts) and whose client
// connects to window.location.origin.
export const resolveCorsOrigin = (
  env: { NODE_ENV?: string; CORS_ORIGIN?: string },
): string | false => {
  if (env.CORS_ORIGIN) return env.CORS_ORIGIN;
  return env.NODE_ENV === 'production' ? SAME_ORIGIN_ONLY : WILDCARD_CORS_ORIGIN;
};
