import path from 'path';
import type { Knex } from 'knex';

// Pure so it can be unit-tested without importing knex — same split as the
// production guards in startupGuards.ts.
//
// DB_PATH exists for deployments where the database must live outside the
// application directory: the Docker image points it at a mounted volume, since
// the default sits inside server/ where a volume mount would shadow the
// sources. Unset it behaves exactly as before.
export const resolveDbFilename = (
  env: { TEST_DB?: string; DB_PATH?: string },
): string => {
  if (env.TEST_DB) return ':memory:';
  if (env.DB_PATH) return env.DB_PATH;
  return path.join(__dirname, 'stats.db');
};

const config: Knex.Config = {
  client: 'sqlite3',
  connection: {
    filename: resolveDbFilename(process.env),
  },
  useNullAsDefault: true,
  // SQLite supports only a single writer. A single shared connection avoids
  // SQLITE_BUSY contention on concurrent stat writes, and is required for an
  // in-memory DB so migrations, writes and reads all hit the same database.
  pool: { min: 1, max: 1 },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
  },
};

export default config;
