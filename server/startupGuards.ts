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
