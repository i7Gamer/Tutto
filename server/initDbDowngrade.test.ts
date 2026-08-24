/**
 * @vitest-environment node
 *
 * Rolling the image back to an older tag while keeping the /data volume leaves
 * knex_migrations naming migrations the running build does not ship. knex
 * refuses to migrate at all then ("the migration directory is corrupt"), which
 * throws out of initDb before server.listen — and `restart: unless-stopped`
 * loops the container on it forever with nothing in the log but "Failed to run
 * database migrations".
 *
 * The migration itself cannot be made to succeed (20260809 changed the
 * device_statistics primary key; the schema does not go backwards). What is
 * fixable is that the operator could not tell what had happened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const migrateLatest = vi.hoisted(() => vi.fn());

vi.mock('knex', () => ({
  default: () => ({ migrate: { latest: migrateLatest }, destroy: vi.fn() }),
}));

import { initDb } from './database';

describe('initDb explains a rolled-back image', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    migrateLatest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the downgrade and what to do about it', async () => {
    migrateLatest.mockRejectedValue(new Error(
      'The migration directory is corrupt, the following files are missing: 20260810000000_classic_stats.js',
    ));

    await expect(initDb()).rejects.toThrow();

    const logged = errors.join('\n');
    expect(logged, 'the operator is told this is a downgrade').toMatch(/NEWER version/i);
    expect(logged, 'and what recovers it').toMatch(/re-pull|restore the backup/i);
  });

  it('still rethrows, so startup does not continue on an unmigrated database', async () => {
    const failure = new Error('The migration directory is corrupt, the following files are missing: x.js');
    migrateLatest.mockRejectedValue(failure);

    await expect(initDb()).rejects.toBe(failure);
  });

  it('does not blame a downgrade for an unrelated migration failure', async () => {
    // A disk error, a locked file, a genuinely broken migration — the hint
    // would send the operator chasing the wrong thing.
    migrateLatest.mockRejectedValue(new Error('SQLITE_CANTOPEN: unable to open database file'));

    await expect(initDb()).rejects.toThrow();

    expect(errors.join('\n')).not.toMatch(/NEWER version/i);
  });

  it('says nothing extra when the migrations run', async () => {
    migrateLatest.mockResolvedValue(undefined);

    await expect(initDb()).resolves.toBeUndefined();

    expect(errors).toEqual([]);
  });
});
