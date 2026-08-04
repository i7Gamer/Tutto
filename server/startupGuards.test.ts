/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  validateApiTokenForStartup,
  validateCorsOriginForStartup,
  resolveCorsOrigin,
  DEV_DEFAULT_API_TOKEN,
  COMPOSE_PLACEHOLDER_API_TOKEN,
  PUBLISHED_API_TOKENS,
  WILDCARD_CORS_ORIGIN,
} from './startupGuards';

describe('validateApiTokenForStartup', () => {
  it('allows any (or no) API_TOKEN outside production', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'development' })).toBeNull();
    expect(validateApiTokenForStartup({ NODE_ENV: 'test', API_TOKEN: DEV_DEFAULT_API_TOKEN })).toBeNull();
  });

  it('refuses to start in production when API_TOKEN is unset', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'production' })).toMatch(/not set/);
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: '' })).toMatch(/not set/);
  });

  it('refuses to start in production when API_TOKEN is the public local-dev default', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: DEV_DEFAULT_API_TOKEN }))
      .toMatch(/published in this repository/);
  });

  it('refuses to start in production when API_TOKEN is the old docker-compose placeholder', () => {
    // The compose file no longer ships a usable default, but copies of the one
    // that did are already deployed. The image is the only thing that reaches
    // them, so the refusal has to live here.
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: COMPOSE_PLACEHOLDER_API_TOKEN }))
      .toMatch(/published in this repository/);
  });

  it('refuses every token this repository has published', () => {
    // Guards the list itself: a value added to PUBLISHED_API_TOKENS but never
    // wired into the check would leave a public token accepted in production.
    const accepted = PUBLISHED_API_TOKENS.filter(
      token => validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: token }) === null
    );
    expect(accepted).toEqual([]);
  });

  it('allows a real API_TOKEN in production', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: 'a-strong-production-token' })).toBeNull();
  });
});

describe('validateCorsOriginForStartup', () => {
  it('allows any (or no) CORS_ORIGIN outside production', () => {
    expect(validateCorsOriginForStartup({ NODE_ENV: 'development' })).toBeNull();
    expect(validateCorsOriginForStartup({ NODE_ENV: 'test', CORS_ORIGIN: '*' })).toBeNull();
  });

  it('allows an unset CORS_ORIGIN in production', () => {
    // Previously refused, because unset meant the '*' dev default. It now
    // resolves to same-origin-only (see resolveCorsOrigin), which is stricter
    // than the wildcard the guard was protecting against — so a published
    // Docker image can boot unconfigured instead of crash-looping.
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production' })).toBeNull();
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production', CORS_ORIGIN: '' })).toBeNull();
  });

  it('refuses to start in production when CORS_ORIGIN is explicitly "*"', () => {
    // Deliberately opting into a wildcard in production stays an error: it
    // would let any site make authenticated cross-origin requests.
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production', CORS_ORIGIN: WILDCARD_CORS_ORIGIN }))
      .toMatch(/CORS_ORIGIN/);
  });

  it('allows a real CORS_ORIGIN in production', () => {
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production', CORS_ORIGIN: 'https://tutto.example.com' })).toBeNull();
  });
});

describe('resolveCorsOrigin', () => {
  it('restricts production to same-origin when CORS_ORIGIN is unset', () => {
    // `false` tells both the cors middleware and Socket.IO to emit no
    // cross-origin headers at all. The frontend is served from this same
    // origin, so nothing in the app needs them.
    expect(resolveCorsOrigin({ NODE_ENV: 'production' })).toBe(false);
    expect(resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGIN: '' })).toBe(false);
  });

  it('keeps the permissive wildcard outside production for local/LAN play', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'development' })).toBe(WILDCARD_CORS_ORIGIN);
    expect(resolveCorsOrigin({})).toBe(WILDCARD_CORS_ORIGIN);
  });

  it('passes an explicit origin through unchanged in any environment', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGIN: 'https://tutto.example.com' }))
      .toBe('https://tutto.example.com');
    expect(resolveCorsOrigin({ NODE_ENV: 'development', CORS_ORIGIN: 'http://localhost:5173' }))
      .toBe('http://localhost:5173');
  });

  it('never resolves to a wildcard in production', () => {
    // The startup guard rejects an explicit '*' before this runs, so the two
    // together mean production can never end up serving Access-Control-Allow-
    // Origin: *.
    const productionOrigins = [
      resolveCorsOrigin({ NODE_ENV: 'production' }),
      resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGIN: '' }),
      resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGIN: 'https://tutto.example.com' }),
    ];
    expect(productionOrigins).not.toContain(WILDCARD_CORS_ORIGIN);
  });
});
