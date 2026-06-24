// Coerce an incoming stats payload into safe values before it reaches the
// additive database merges. Numbers are floored, clamped to a non-negative
// range, and capped; booleans and explicit nulls are preserved (e.g.
// isDefaultGame, fastestWinTurns); anything non-finite (strings, NaN, objects)
// is dropped so clients can't poison the aggregate statistics.
const STATS_VALUE_CAP = 1e9;

const sanitizeStats = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  const clean = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'boolean' || val === null) {
      clean[key] = val;
      continue;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    
    let minAllowed = 0;
    if (key === 'fastestWinTurns' || key === 'fastestLossTurns') {
      minAllowed = 1;
    }
    
    clean[key] = Math.max(minAllowed, Math.min(Math.floor(n), STATS_VALUE_CAP));
  }
  return clean;
};

module.exports = { sanitizeStats, STATS_VALUE_CAP };
