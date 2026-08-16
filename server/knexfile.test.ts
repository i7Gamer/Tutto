/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import path from 'path';
import knexConfig, { resolveDbFilename } from './knexfile';

// The historical location, still where a production server looks, so existing
// bare-metal installs keep finding the database they already have. Only a
// development server was moved off it.
const DEFAULT_DB_FILE = path.join(__dirname, 'stats.db');

describe('resolveDbFilename', () => {
  it('uses an in-memory database when TEST_DB is set', () => {
    expect(resolveDbFilename({ TEST_DB: 'true' })).toBe(':memory:');
  });

  it('lets TEST_DB win over DB_PATH', () => {
    // Otherwise a developer with DB_PATH exported in their shell would have the
    // suites quietly writing to a real database file.
    expect(resolveDbFilename({ TEST_DB: 'true', DB_PATH: '/data/stats.db' })).toBe(':memory:');
  });

  it('honours DB_PATH when set', () => {
    // How the Docker image points the database at its mounted volume.
    expect(resolveDbFilename({ DB_PATH: '/data/stats.db' })).toBe('/data/stats.db');
  });

  it('falls back to the environment default when DB_PATH is empty', () => {
    // An empty value is not a path — a deployment that exports DB_PATH= and
    // means nothing by it should land where it would have without it.
    expect(resolveDbFilename({ DB_PATH: '', NODE_ENV: 'production' })).toBe(DEFAULT_DB_FILE);
    expect(resolveDbFilename({ DB_PATH: '' })).toBe(path.join(__dirname, 'stats.dev.db'));
  });

  it('serves production from stats.db next to the server sources', () => {
    expect(resolveDbFilename({ NODE_ENV: 'production' })).toBe(DEFAULT_DB_FILE);
  });

  it('keeps a development server off the production database', () => {
    // A dev server on a machine that also runs the real thing was writing its
    // throwaway games into the real statistics — the same hazard the API proxy
    // had, one layer down. Nothing has to be configured to be safe here; the
    // deployments that want the production file already say NODE_ENV.
    const devFile = resolveDbFilename({});

    expect(devFile).not.toBe(DEFAULT_DB_FILE);
    expect(devFile).toBe(path.join(__dirname, 'stats.dev.db'));
  });

  it('still lets DB_PATH place the database wherever a deployment needs it', () => {
    // Whatever NODE_ENV says: the Docker image sets both, and the mounted
    // volume is the answer.
    expect(resolveDbFilename({ DB_PATH: '/data/stats.db' })).toBe('/data/stats.db');
    expect(resolveDbFilename({ DB_PATH: '/data/stats.db', NODE_ENV: 'production' })).toBe('/data/stats.db');
  });
});

describe('knex configuration', () => {
  // The sqlite3 client reads the config two ways: it calls the connection
  // provider when the pool opens a connection, and reads .filename off it while
  // constructing the client (only to warn when there is none). Both are pinned.
  const connection = knexConfig.connection as unknown as (() => { filename: string }) & { filename: string };

  // A path nothing here could produce by accident, exported into the
  // environment only inside a case — i.e. long after the import at the top of
  // this file evaluated the config.
  const LATE_DB_PATH = '/late-mounted-volume/stats.db';

  // Applies env overrides for the duration of fn and restores them afterwards
  // (undefined = unset). TEST_DB is among them: the runner sets it (see
  // vite.config.ts), and it short-circuits every other branch of the resolver,
  // so a case that never touches it can only ever observe ':memory:'.
  const withEnv = (overrides: Record<string, string | undefined>, fn: () => void): void => {
    const original: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      original[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('reads the database path when the pool connects, not when the module was imported', () => {
    // The whole point of the connection *provider*: index.ts loads .env with a
    // statement, so every import in that file — ./database, which builds knex
    // out of this config, among them — has already run by the time a DB_PATH
    // set there exists. The override below therefore lands after this file's
    // own import, the same way round; a config that had baked its filename in
    // at import time would still answer the pre-.env value here.
    withEnv({ TEST_DB: undefined, DB_PATH: LATE_DB_PATH }, () => {
      expect(connection.filename).toBe(LATE_DB_PATH);
      expect(connection().filename).toBe(LATE_DB_PATH);
    });
  });

  it('resolves its filename through resolveDbFilename', () => {
    // Not `toBe(resolveDbFilename(process.env))`: under the runner's TEST_DB
    // both sides of that collapse to ':memory:' no matter what the config does
    // with the rest of the environment, so it no longer discriminates anything.
    // Pinned instead on envs this case controls, which show the config routing
    // the WHOLE environment through the resolver — DB_PATH and the NODE_ENV
    // fallback both, each against the resolver's own answer for that env.
    withEnv({ TEST_DB: undefined, DB_PATH: LATE_DB_PATH }, () => {
      expect(connection.filename).toBe(resolveDbFilename({ DB_PATH: LATE_DB_PATH }));
    });
    withEnv({ TEST_DB: undefined, DB_PATH: undefined, NODE_ENV: 'production' }, () => {
      expect(connection.filename).toBe(resolveDbFilename({ NODE_ENV: 'production' }));
      expect(connection.filename).toBe(DEFAULT_DB_FILE);
    });
  });

  it('keeps the single-connection pool sqlite needs', () => {
    expect(knexConfig.pool).toEqual({ min: 1, max: 1 });
  });
});
