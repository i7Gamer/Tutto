const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'stats.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS device_statistics (
      deviceId TEXT PRIMARY KEY,
      gamesPlayed INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      pointsDeducted INTEGER DEFAULT 0,
      plusMinusCompleted INTEGER DEFAULT 0,
      plusMinusFailed INTEGER DEFAULT 0,
      kniffelCompleted INTEGER DEFAULT 0,
      kniffelFailed INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      feuerwerkReceived INTEGER DEFAULT 0,
      kleeblattFailed INTEGER DEFAULT 0,
      x2Received INTEGER DEFAULT 0,
      totalPlaytime INTEGER DEFAULT 0
    )
  `);

  db.run("ALTER TABLE device_statistics ADD COLUMN totalPlaytime INTEGER DEFAULT 0", (err) => {
    // Ignore error if column already exists
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS global_statistics (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      totalGamesPlayed INTEGER DEFAULT 0,
      totalPlaytime INTEGER DEFAULT 0,
      totalPlusMinus INTEGER DEFAULT 0,
      totalKniffel INTEGER DEFAULT 0,
      totalStop INTEGER DEFAULT 0,
      totalFeuerwerk INTEGER DEFAULT 0,
      totalKleeblatt INTEGER DEFAULT 0,
      totalx2 INTEGER DEFAULT 0
    )
  `);

  db.run(`INSERT OR IGNORE INTO global_statistics (id) VALUES (1)`);
});

const getDeviceStats = (deviceId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM device_statistics WHERE deviceId = ?', [deviceId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
};

const updateDeviceStats = (deviceId, stats) => {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO device_statistics (
        deviceId, gamesPlayed, wins, pointsDeducted, plusMinusCompleted, 
        plusMinusFailed, kniffelCompleted, kniffelFailed, skipped, 
        feuerwerkReceived, kleeblattFailed, x2Received, totalPlaytime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET
        gamesPlayed = gamesPlayed + excluded.gamesPlayed,
        wins = wins + excluded.wins,
        pointsDeducted = pointsDeducted + excluded.pointsDeducted,
        plusMinusCompleted = plusMinusCompleted + excluded.plusMinusCompleted,
        plusMinusFailed = plusMinusFailed + excluded.plusMinusFailed,
        kniffelCompleted = kniffelCompleted + excluded.kniffelCompleted,
        kniffelFailed = kniffelFailed + excluded.kniffelFailed,
        skipped = skipped + excluded.skipped,
        feuerwerkReceived = feuerwerkReceived + excluded.feuerwerkReceived,
        kleeblattFailed = kleeblattFailed + excluded.kleeblattFailed,
        x2Received = x2Received + excluded.x2Received,
        totalPlaytime = totalPlaytime + excluded.totalPlaytime
    `, [
      deviceId,
      stats.gamesPlayed || 0,
      stats.wins || 0,
      stats.pointsDeducted || 0,
      stats.plusMinusCompleted || 0,
      stats.plusMinusFailed || 0,
      stats.kniffelCompleted || 0,
      stats.kniffelFailed || 0,
      stats.skipped || 0,
      stats.feuerwerkReceived || 0,
      stats.kleeblattFailed || 0,
      stats.x2Received || 0,
      stats.totalPlaytime || 0
    ], function(err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
  });
};

const getGlobalStats = () => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM global_statistics WHERE id = 1', (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
};

const updateGlobalStats = (stats) => {
  return new Promise((resolve, reject) => {
    db.run(`
      UPDATE global_statistics SET
        totalGamesPlayed = totalGamesPlayed + ?,
        totalPlaytime = totalPlaytime + ?,
        totalPlusMinus = totalPlusMinus + ?,
        totalKniffel = totalKniffel + ?,
        totalStop = totalStop + ?,
        totalFeuerwerk = totalFeuerwerk + ?,
        totalKleeblatt = totalKleeblatt + ?,
        totalx2 = totalx2 + ?
      WHERE id = 1
    `, [
      stats.gamesPlayed || 0,
      stats.totalPlaytime || 0,
      stats.totalPlusMinus || 0,
      stats.totalKniffel || 0,
      stats.totalStop || 0,
      stats.totalFeuerwerk || 0,
      stats.totalKleeblatt || 0,
      stats.totalx2 || 0
    ], function(err) {
      if (err) return reject(err);
      resolve(this.changes);
    });
  });
};

module.exports = { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats };
