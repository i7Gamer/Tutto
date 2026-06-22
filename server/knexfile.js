const path = require('path');

module.exports = {
  client: 'sqlite3',
  connection: {
    filename: process.env.TEST_DB ? ':memory:' : path.join(__dirname, 'stats.db')
  },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(__dirname, 'migrations')
  }
};
