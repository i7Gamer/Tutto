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

export const validateCorsOriginForStartup = (
  env: { NODE_ENV?: string; CORS_ORIGIN?: string },
): string | null => {
  const corsOrigin = env.CORS_ORIGIN || '*';
  if (env.NODE_ENV === 'production' && corsOrigin === '*') {
    return '[SECURITY] CORS_ORIGIN is not set (defaults to "*"). Refusing to start in production.';
  }
  return null;
};
