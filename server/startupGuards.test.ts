/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  validateApiTokenForStartup,
  validateCorsOriginForStartup,
  resolveCorsOrigin,
  isProxyTrusted,
  warnIfProxyTrustUnset,
  validatePortForStartup,
  resolvePortForStartup,
  describeListenError,
  type ErrnoException,
  DEV_DEFAULT_API_TOKEN,
  COMPOSE_PLACEHOLDER_API_TOKEN,
  PUBLISHED_API_TOKENS,
  WILDCARD_CORS_ORIGIN,
  DEFAULT_PORT,
} from './startupGuards';
import knexConfig, { resolveDbFilename } from './knexfile';

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

  // A stray space in a .env line is the easiest typo there is, and it made a
  // published token miss the list by one character — the deployment then ran
  // on a secret that is public knowledge plus a space. Only the comparison
  // trims; the token that actually authenticates is left byte-for-byte as
  // configured, so this cannot change which credential works on a running
  // deployment.
  it('sees through surrounding whitespace on a published token', () => {
    for (const token of PUBLISHED_API_TOKENS) {
      expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: `${token} ` }))
        .toMatch(/published in this repository/);
      expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: `  ${token}\t` }))
        .toMatch(/published in this repository/);
    }
  });

  it('refuses a token that is nothing but whitespace', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: '   ' }))
      .toMatch(/API_TOKEN is not set/);
  });

  it('allows a real API_TOKEN in production', () => {
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: 'a-strong-production-token' })).toBeNull();
    // Whitespace inside a genuine token is not what the trim is about — the
    // value still authenticates exactly as configured.
    expect(validateApiTokenForStartup({ NODE_ENV: 'production', API_TOKEN: ' a-strong-production-token ' })).toBeNull();
  });
});

describe('isProxyTrusted / warnIfProxyTrustUnset', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('trusts the proxy hop only on an explicit TRUST_PROXY=1', () => {
    vi.stubEnv('TRUST_PROXY', '');
    expect(isProxyTrusted()).toBe(false);
    // NODE_ENV deliberately does not imply the topology.
    vi.stubEnv('NODE_ENV', 'production');
    expect(isProxyTrusted()).toBe(false);
    vi.stubEnv('TRUST_PROXY', '1');
    expect(isProxyTrusted()).toBe(true);
    vi.stubEnv('TRUST_PROXY', 'true');
    expect(isProxyTrusted()).toBe(false);
  });

  it('warns once at production startup when the flag is unset, and stays quiet otherwise', () => {
    const log = vi.fn();

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUST_PROXY', '');
    warnIfProxyTrustUnset(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('TRUST_PROXY');

    log.mockClear();
    vi.stubEnv('TRUST_PROXY', '1');
    warnIfProxyTrustUnset(log);
    expect(log).not.toHaveBeenCalled();

    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TRUST_PROXY', '');
    warnIfProxyTrustUnset(log);
    expect(log).not.toHaveBeenCalled();
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

describe('validatePortForStartup', () => {
  it('allows an unset or empty PORT (the default applies)', () => {
    expect(validatePortForStartup({})).toBeNull();
    expect(validatePortForStartup({ PORT: '' })).toBeNull();
  });

  it('allows any integer in the valid 1..65535 range, including the boundaries', () => {
    expect(validatePortForStartup({ PORT: '1' })).toBeNull();
    expect(validatePortForStartup({ PORT: '3001' })).toBeNull();
    expect(validatePortForStartup({ PORT: '65535' })).toBeNull();
  });

  it('refuses 0: it binds an ephemeral port silently instead of the one requested', () => {
    expect(validatePortForStartup({ PORT: '0' })).toMatch(/PORT/);
  });

  it('refuses non-numeric junk instead of letting it crash with a raw stack', () => {
    expect(validatePortForStartup({ PORT: 'abc' })).toMatch(/PORT/);
  });

  it('refuses a port above the valid range', () => {
    expect(validatePortForStartup({ PORT: '70000' })).toMatch(/PORT/);
  });

  it('refuses a negative port', () => {
    expect(validatePortForStartup({ PORT: '-5' })).toMatch(/PORT/);
  });

  it('refuses a non-integer port', () => {
    expect(validatePortForStartup({ PORT: '3001.5' })).toMatch(/PORT/);
  });

  it('names the offending value in the refusal message', () => {
    expect(validatePortForStartup({ PORT: 'abc' })).toContain('abc');
  });
});

describe('resolvePortForStartup', () => {
  it('resolves to the named default constant when PORT is unset or empty', () => {
    expect(resolvePortForStartup({})).toBe(DEFAULT_PORT);
    expect(resolvePortForStartup({ PORT: '' })).toBe(DEFAULT_PORT);
  });

  it('parses a configured PORT to a number', () => {
    expect(resolvePortForStartup({ PORT: '8080' })).toBe(8080);
  });
});

describe('describeListenError', () => {
  const asErrno = (code: string): ErrnoException => {
    const err = new Error(`listen ${code}`) as ErrnoException;
    err.code = code;
    return err;
  };

  it('names EADDRINUSE and the port in one readable line', () => {
    const message = describeListenError(asErrno('EADDRINUSE'), 3001);
    expect(message).toContain('3001');
    expect(message).toMatch(/in use/i);
  });

  it('names EACCES and the port in one readable line', () => {
    const message = describeListenError(asErrno('EACCES'), 80);
    expect(message).toContain('80');
    expect(message).toMatch(/permission/i);
  });

  it('falls back to the raw error message for an unrecognised code', () => {
    const err = asErrno('EWEIRD');
    const message = describeListenError(err, 3001);
    expect(message).toContain('3001');
    expect(message).toContain(err.message);
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

  it('ships a PORT the startup guard accepts', () => {
    expect(validatePortForStartup(productionEnv)).toBeNull();
  });

  it('still gives local development the permissive wildcard', () => {
    // The reason CORS_ORIGIN=* was in the file at all. Unset already resolves
    // to '*' outside production, so dropping the line costs dev nothing.
    expect(resolveCorsOrigin({ ...example, NODE_ENV: 'development' })).toBe(WILDCARD_CORS_ORIGIN);
  });
});

// index.ts prints the statistics database at startup, and knex opens the one
// the knexfile points at — a deployment that set DB_PATH in .env had the two
// disagree, connecting to the default database while the log named the .env
// path. A value from .env only reaches process.env when index.ts calls
// dotenv.config(), a statement, so every import in that file has already been
// evaluated by the time it runs — ./database, which builds the knex instance
// out of this config, among them. Importing the knexfile at the top of this
// file and setting DB_PATH inside the test reproduces that order exactly. A
// real .env is deliberately not written: it is the developer's own gitignored
// file, and the suites that spawn server processes would read it mid-run.
describe('the database knex opens and the database startup logs', () => {
  // Stands in for a DB_PATH line in a copied .env — the documented way to put
  // the database somewhere other than the application directory.
  const DOTENV_SUPPLIED_DB_PATH = '/data/from-dotenv.db';

  // Whichever shape the knexfile uses: knex clones a connection object when
  // the client is constructed, and calls a connection provider when the pool
  // opens its first connection.
  const filenameKnexWillOpen = (): string => {
    const connection = knexConfig.connection as { filename: string } | (() => { filename: string });
    return typeof connection === 'function' ? connection().filename : connection.filename;
  };

  // The whole suite runs with TEST_DB set (see vite.config.ts), which outranks
  // DB_PATH by design, so it has to be cleared for these to stand in for a
  // real server process.
  const asServerProcess = (): void => {
    vi.stubEnv('TEST_DB', '');
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('agrees on a DB_PATH that arrives only once .env has been loaded', () => {
    asServerProcess();
    vi.stubEnv('DB_PATH', DOTENV_SUPPLIED_DB_PATH);

    expect(filenameKnexWillOpen()).toBe(DOTENV_SUPPLIED_DB_PATH);
    // resolveDbFilename(process.env) is what index.ts logs at startup.
    expect(filenameKnexWillOpen()).toBe(resolveDbFilename(process.env));
  });

  it('agrees on the environment default when nothing sets DB_PATH', () => {
    // The other direction: a connection that simply always answered with
    // DB_PATH would satisfy the case above and take every unconfigured
    // deployment to the wrong file.
    asServerProcess();

    expect(filenameKnexWillOpen()).toBe(resolveDbFilename(process.env));
    expect(filenameKnexWillOpen()).not.toBe(DOTENV_SUPPLIED_DB_PATH);
  });

  it('still lets TEST_DB win over a DB_PATH from .env', () => {
    // Resolving later must not reorder the precedence resolveDbFilename
    // defines: a developer with DB_PATH in .env would otherwise have the
    // suites writing into a real database file.
    vi.stubEnv('DB_PATH', DOTENV_SUPPLIED_DB_PATH);

    expect(filenameKnexWillOpen()).toBe(':memory:');
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
