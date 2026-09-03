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

// Resolved when the pool opens its first connection, not when this module is
// imported. index.ts loads .env with a dotenv.config() *statement*, so every
// import in that file has already been evaluated by the time it runs —
// ./database, which builds the knex instance out of this config, among them.
// A `{ filename }` object here is deep-cloned into the client at that moment,
// i.e. before a DB_PATH set in .env exists, so the server connected to the
// default database while index.ts logged the .env path as the one in use. A
// connection *provider* is called after startup instead, which is after .env.
// (api.ts documents the same import-order hazard for its own env reads.)
const resolveConnection = (): Knex.Sqlite3ConnectionConfig => ({
  filename: resolveDbFilename(process.env),
});

// The sqlite3 client still looks for connection.filename when it is
// constructed, purely to warn when it finds none — answered here with the same
// value the provider returns, as a getter so this stays a live read too.
Object.defineProperty(resolveConnection, 'filename', {
  get: (): string => resolveDbFilename(process.env),
});

/**
 * How long sqlite waits for a held lock before failing a statement with
 * SQLITE_BUSY.
 *
 * Its default is 0 — the write fails on the spot. The pool below is a single
 * connection, so nothing inside this process contends with itself, but the
 * database file is not this process's alone: a second Tutto instance, a
 * backup or a `sqlite3` session on the same file all take locks, and each one
 * turned an endGameStats write into an instant error. That handler's failure
 * path is a rollback and a log line, so the losing device's row for that game
 * was simply gone. Generous next to any write here (all of them are one small
 * upsert), far below the socket round trip a client would notice.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** What node-sqlite3 hands `afterCreate`, reduced to the part used here. */
type SqliteConnection = { run: (sql: string, cb: (err: Error | null) => void) => void };

/**
 * Pragmas applied to every connection the pool opens, in order.
 *
 * Per-connection state in sqlite, not per-database — so this has to run on
 * each new connection rather than once at startup. busy_timeout comes first
 * so the journal-mode switch, which needs a lock of its own, already benefits
 * from it. WAL lets readers (the /api/stats endpoints, a backup) run
 * concurrently with the writer instead of locking it out, which is the other
 * half of why a stats write used to fail.
 */
const CONNECTION_PRAGMAS: readonly string[] = [
  `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`,
  'PRAGMA journal_mode = WAL',
];

/**
 * knex's pool.afterCreate hook: configure the connection, then release it.
 *
 * Exported (and pure apart from the connection it is handed) so the pragmas
 * can be pinned without opening a real database — see knexfile.test.ts. A
 * failing pragma is reported to the pool rather than swallowed: a connection
 * that silently kept the sqlite defaults is exactly the state this exists to
 * prevent.
 */
export const configureSqliteConnection = (
  conn: SqliteConnection,
  done: (err: Error | null, conn: SqliteConnection) => void,
): void => {
  const runFrom = (index: number): void => {
    if (index >= CONNECTION_PRAGMAS.length) return done(null, conn);
    conn.run(CONNECTION_PRAGMAS[index], err => {
      if (err) return done(err, conn);
      runFrom(index + 1);
    });
  };
  runFrom(0);
};

const config: Knex.Config = {
  client: 'sqlite3',
  connection: resolveConnection,
  useNullAsDefault: true,
  // SQLite supports only a single writer. A single shared connection avoids
  // SQLITE_BUSY contention on concurrent stat writes, and is required for an
  // in-memory DB so migrations, writes and reads all hit the same database.
  pool: { min: 1, max: 1, afterCreate: configureSqliteConnection },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
  },
};

export default config;
