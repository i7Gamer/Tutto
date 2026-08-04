/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import path from 'path';
import knexConfig, { resolveDbFilename } from './knexfile';

// The historical location, kept as the default so existing local and
// bare-metal installs keep finding their database after DB_PATH was added.
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

  it('falls back to the default when DB_PATH is empty', () => {
    expect(resolveDbFilename({ DB_PATH: '' })).toBe(DEFAULT_DB_FILE);
  });

  it('defaults to stats.db next to the server sources', () => {
    expect(resolveDbFilename({})).toBe(DEFAULT_DB_FILE);
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
