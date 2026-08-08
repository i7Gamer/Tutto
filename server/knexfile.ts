import path from 'path';
import type { Knex } from 'knex';

/** Where a real deployment keeps its statistics. */
const PRODUCTION_DB_FILE = 'stats.db';

/**
 * Where a development server keeps its throwaway ones. Separate because the
 * two are often the same machine: running `npm run server` next to a live
 * instance had a few test games writing into the real statistics, which is
 * the hazard the API proxy had one layer up (see API_TARGET in vite.config).
 */
const DEVELOPMENT_DB_FILE = 'stats.dev.db';

// Pure so it can be unit-tested without importing knex — same split as the
// production guards in startupGuards.ts.
//
// DB_PATH exists for deployments where the database must live outside the
// application directory: the Docker image points it at a mounted volume, since
// the default sits inside server/ where a volume mount would shadow the
// sources. It wins over everything but the test database.
//
// Without it, NODE_ENV decides. Both production paths already set it — the
// image in its ENV block, `npm run start:prod` through cross-env — so they
// keep the file they have always used; anything else is a development server
// and gets its own. The file in use is logged at startup (server/index.ts),
// because a database quietly resolving somewhere other than expected is not
// something to discover from an empty statistics screen.
export const resolveDbFilename = (
  env: { TEST_DB?: string; DB_PATH?: string; NODE_ENV?: string },
): string => {
  if (env.TEST_DB) return ':memory:';
  if (env.DB_PATH) return env.DB_PATH;
  return path.join(__dirname, env.NODE_ENV === 'production' ? PRODUCTION_DB_FILE : DEVELOPMENT_DB_FILE);
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
