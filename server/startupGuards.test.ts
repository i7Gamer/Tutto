/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  validateApiTokenForStartup,
  validateCorsOriginForStartup,
  resolveCorsOrigin,
  DEV_DEFAULT_API_TOKEN,
  COMPOSE_PLACEHOLDER_API_TOKEN,
  PUBLISHED_API_TOKENS,
  WILDCARD_CORS_ORIGIN,
} from './startupGuards';

const ENV_EXAMPLE_PATH = path.join(__dirname, '..', '.env.example');
// Stands in for the secret the README tells a deployer to export before
// `npm run start:prod`. Any non-published value works; the point is that it
// comes from the environment rather than from the example file.
const OPERATOR_SUPPLIED_API_TOKEN = 'a-strong-production-token';

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

// The guards above are only half the contract: they also have to agree with
// the file the README tells people to copy. `.env.example` used to ship
// CORS_ORIGIN=*, which every guard here correctly refuses — so following the
// documented setup produced a server that exited 1 instead of booting.
describe('.env.example is a startable production configuration', () => {
  // Parsed with the same library index.ts loads it with, so this sees exactly
  // the values a copied `.env` would put into process.env.
  const example = dotenv.parse(fs.readFileSync(ENV_EXAMPLE_PATH));

  // The README's production path: copy the example, export a real API_TOKEN
  // (dotenv never overrides a variable already in the environment), then
  // `npm run start:prod`. Every other value still comes from the file.
  const productionEnv = {
    ...example,
    NODE_ENV: 'production',
    API_TOKEN: OPERATOR_SUPPLIED_API_TOKEN,
  };

  it('ships an API_TOKEN that is overridable from the environment', () => {
    // The example deliberately ships the public local-dev default so `npm
    // start` works unedited. That is only safe because the production guard
    // refuses it AND the documented fix — exporting the real token — wins over
    // the file. Both halves are asserted here.
    expect(example.API_TOKEN).toBe(DEV_DEFAULT_API_TOKEN);
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: example.API_TOKEN }))
      .toMatch(/published in this repository/);
    expect(validateApiTokenForStartup(productionEnv)).toBeNull();
  });

  it('ships no CORS_ORIGIN the production guard refuses', () => {
    // Unlike API_TOKEN there is no documented override step for this one — the
    // README says to leave it unset — so a refused value here is unreachable
    // to fix without editing the copied file.
    expect(validateCorsOriginForStartup(productionEnv)).toBeNull();
  });

  it('leaves production same-origin only, as the README documents', () => {
    expect(resolveCorsOrigin(productionEnv)).toBe(false);
  });

  it('still gives local development the permissive wildcard', () => {
    // The reason CORS_ORIGIN=* was in the file at all. Unset already resolves
    // to '*' outside production, so dropping the line costs dev nothing.
    expect(resolveCorsOrigin({ ...example, NODE_ENV: 'development' })).toBe(WILDCARD_CORS_ORIGIN);
  });
});

// PUBLISHED_API_TOKENS is a list of literals this repository has made public,
// and it can only be complete if nothing else in the repository publishes one.
// A CI workflow that hard-codes a token is exactly that: readable by anyone,
// and accepted by the production guard, so a deployer who copies the line out
// of a workflow file gets a server whose admin token is on GitHub.
describe('no workflow publishes a usable production API_TOKEN', () => {
  const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
  // `NAME: value` in a YAML env block, and `NAME=value` in a shell line.
  const API_TOKEN_ASSIGNMENT = /API_TOKEN\s*[:=]\s*(\S+)/g;
  // A shell expansion or an Actions expression is a value, not a literal.
  const isExpansion = (value: string): boolean => value.startsWith('$');

  const assignments = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .flatMap(file => {
      const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      return [...source.matchAll(API_TOKEN_ASSIGNMENT)].map(match => ({
        file,
        value: (match[1] as string).replace(/^["']|["'\\]+$/g, ''),
      }));
    });

  it('finds the API_TOKEN assignments it is meant to be checking', () => {
    // Without this, a renamed variable or a moved directory would make the
    // assertion below pass by scanning nothing at all.
    expect(assignments.length).toBeGreaterThan(0);
  });

  it('assigns no literal the production guard would accept', () => {
    const usable = assignments
      .filter(({ value }) => !isExpansion(value))
      .filter(({ value }) => validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: value }) === null)
      .map(({ file, value }) => `${file}: ${value}`);

    expect(usable).toEqual([]);
  });
});
