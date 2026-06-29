import path from 'path';
import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'sqlite3',
  connection: {
    filename: process.env.TEST_DB ? ':memory:' : path.join(__dirname, 'stats.db'),
  },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(__dirname, 'migrations'),
  },
};

export default config;
