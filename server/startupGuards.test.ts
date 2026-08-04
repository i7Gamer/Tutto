/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { validateApiTokenForStartup, validateCorsOriginForStartup, DEV_DEFAULT_API_TOKEN } from './startupGuards';

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
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: DEV_DEFAULT_API_TOKEN })).toMatch(/local-dev default/);
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

  it('refuses to start in production when CORS_ORIGIN is unset (defaults to wildcard)', () => {
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production' })).toMatch(/CORS_ORIGIN/);
  });

  it('refuses to start in production when CORS_ORIGIN is explicitly "*"', () => {
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production', CORS_ORIGIN: '*' })).toMatch(/CORS_ORIGIN/);
  });

  it('allows a real CORS_ORIGIN in production', () => {
    expect(validateCorsOriginForStartup({ NODE_ENV: 'production', CORS_ORIGIN: 'https://tutto.rzipas.win' })).toBeNull();
  });
});
