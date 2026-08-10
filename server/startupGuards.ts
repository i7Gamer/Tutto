// Pure validation logic for the production startup guards in index.ts/api.ts,
// split out so it can be unit-tested without spawning a real server
// subprocess (which is both slow and, under a parallel test run, a source of
// port-contention flakiness).

// Public-knowledge local-dev fallback for API_TOKEN — never valid in production.
export const DEV_DEFAULT_API_TOKEN = 'tutto-local-dev-token';

// The placeholder docker-compose.yml shipped with before it required API_TOKEN
// to be supplied. It passed this guard, so `docker compose up -d` on an
// unedited copy started a production server whose admin token is readable off
// GitHub. Copies of that file are already deployed and a published image is the
// only artefact that reaches them, so the refusal has to live here.
export const COMPOSE_PLACEHOLDER_API_TOKEN = 'change-me-openssl-rand-hex-32';

// Every API_TOKEN value this repository has published. All of them are public
// knowledge, so none may guard the admin endpoints of a production deployment.
export const PUBLISHED_API_TOKENS: readonly string[] = [
  DEV_DEFAULT_API_TOKEN,
  COMPOSE_PLACEHOLDER_API_TOKEN,
];

export const validateApiTokenForStartup = (
  env: { NODE_ENV?: string; API_TOKEN?: string },
): string | null => {
  if (env.NODE_ENV !== 'production') return null;
  if (!env.API_TOKEN) return '[SECURITY] API_TOKEN is not set. Refusing to start in production.';
  if (PUBLISHED_API_TOKENS.includes(env.API_TOKEN)) {
    return '[SECURITY] API_TOKEN is set to a placeholder published in this repository, so it is public knowledge. Refusing to start in production.';
  }
  return null;
};

// Any origin. The dev/LAN-play default, and never a legal production value.
// Whether exactly one reverse-proxy hop in front of this server is trusted to
// have appended the real client address to X-Forwarded-For. This is a network
// TOPOLOGY fact only the deployer knows — deliberately not inferred from
// NODE_ENV (a production build can run directly exposed, where trusting the
// header lets any client forge itself a fresh rate-limiter bucket per
// connection) and not auto-detected from peer addresses (LAN clients connect
// directly from private addresses, and a containerized proxy arrives from a
// non-loopback bridge address — every heuristic misreads one of them).
// Express's `trust proxy` (index.ts) and the socket connection limiter
// (socketHandlers.getClientAddress) both key off this single answer.
export const isProxyTrusted = (): boolean => process.env.TRUST_PROXY === '1';

// A production deployment behind a proxy that forgot the flag keys every real
// user as the proxy's own address — one shared rate-limit bucket for all of
// them. That misconfiguration is loud (everyone throttled together) but
// baffling without a name; this prints it once at startup.
export const warnIfProxyTrustUnset = (log: (msg: string) => void = console.warn): void => {
  if (process.env.NODE_ENV === 'production' && !isProxyTrusted()) {
    log('[startup] TRUST_PROXY is not set: client addresses are read from the raw connection. '
      + 'If this server sits behind exactly one reverse proxy, set TRUST_PROXY=1 so per-IP '
      + "rate limiting sees real client addresses instead of the proxy's.");
  }
};

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
