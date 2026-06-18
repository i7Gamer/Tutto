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
      x2Received INTEGER DEFAULT 0
    )
  `);
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
        feuerwerkReceived, kleeblattFailed, x2Received
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        x2Received = x2Received + excluded.x2Received
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
      stats.x2Received || 0
    ], function(err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
  });
};

module.exports = { getDeviceStats, updateDeviceStats };
