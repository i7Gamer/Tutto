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
  // Trimmed for the COMPARISON only — api.ts still authenticates against the
  // raw value, so what counts as a valid token on a running deployment is
  // unchanged. A stray space in a .env line is the easiest typo there is, and
  // it used to slip a published placeholder past this list by one character:
  // the server then started on a secret that is public knowledge plus a space.
  const token = env.API_TOKEN?.trim();
  if (!token) return '[SECURITY] API_TOKEN is not set. Refusing to start in production.';
  if (PUBLISHED_API_TOKENS.includes(token)) {
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

// Unset PORT (local dev, and every documented deployment path) falls back to
// this. Named so it is never retyped as a bare 3001 at the two call sites
// that need it (the guard's error message and the resolver below).
export const DEFAULT_PORT = 3001;

const MIN_PORT = 1;
const MAX_PORT = 65535;

// Anything but digits is refused outright, which also rejects '3001.5',
// '+3001', leading/trailing whitespace and the empty string reaching this
// far — a value this strict never needs Number()'s own leniency (it parses
// '3001abc' as 3001) to be re-guarded against.
const PORT_PATTERN = /^\d+$/;

const describeInvalidPort = (raw: string): string =>
  `[STARTUP] PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}, got ${JSON.stringify(raw)}. Refusing to start.`;

// PORT=<junk> used to reach server.listen() unguarded, where Node either
// crashed with a raw stack (non-numeric) or silently bound an ephemeral port
// instead of the one requested (PORT=0). Unset or empty means "use the
// default" and is not an error; anything else must be a plain integer in the
// valid TCP port range.
export const validatePortForStartup = (
  env: { PORT?: string },
): string | null => {
  const raw = env.PORT;
  if (raw === undefined || raw === '') return null;
  if (!PORT_PATTERN.test(raw)) return describeInvalidPort(raw);
  const port = Number(raw);
  if (port < MIN_PORT || port > MAX_PORT) return describeInvalidPort(raw);
  return null;
};

// Only meaningful once validatePortForStartup has passed (index.ts calls the
// guard first and exits on a non-null result, the same order as CORS_ORIGIN
// above) — this does not re-validate.
export const resolvePortForStartup = (env: { PORT?: string }): number => {
  const raw = env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  return Number(raw);
};

// The shape Node attaches to a system-call error (ECONNRESET, EADDRINUSE, ...)
// on top of plain Error — @types/node exposes it only as the ambient global
// NodeJS.ErrnoException, which this repo's eslint config flags as `no-undef`
// (a known typescript-eslint gotcha: plain `no-undef` predates TS's own
// checking of ambient type namespaces). A local shape says exactly what this
// file reads off the error without relying on that global.
export interface ErrnoException extends Error {
  code?: string;
}

// server.listen() emits 'error' instead of throwing, and Node's default
// listener for an EventEmitter with no listeners is to throw the raw error
// and crash — the port range guard above still leaves EADDRINUSE (something
// else is already listening) and EACCES (privileged port, or an OS policy)
// reachable at listen time. Named per code so an operator sees the actual
// problem instead of an ELF-looking stack trace.
export const describeListenError = (err: ErrnoException, port: number): string => {
  if (err.code === 'EADDRINUSE') {
    return `[STARTUP] Port ${port} is already in use. Stop whatever is listening on it, or set PORT to a free one. Refusing to start.`;
  }
  if (err.code === 'EACCES') {
    return `[STARTUP] Permission denied binding to port ${port} (ports below 1024 usually need elevated privileges). Refusing to start.`;
  }
  return `[STARTUP] Failed to start listening on port ${port}: ${err.message}. Refusing to start.`;
};
