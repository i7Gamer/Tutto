import path from 'path';
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'sqlite3',
  connection: {
    filename: process.env.TEST_DB ? ':memory:' : path.join(__dirname, 'stats.db'),
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
