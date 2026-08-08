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
  it('resolves its filename through resolveDbFilename', () => {
    const connection = knexConfig.connection as { filename: string };
    expect(connection.filename).toBe(resolveDbFilename(process.env));
  });

  it('keeps the single-connection pool sqlite needs', () => {
    expect(knexConfig.pool).toEqual({ min: 1, max: 1 });
  });
});
