export const STATS_VALUE_CAP = 1e9;

export type SanitizedStats = Record<string, number | boolean | null>;

export const sanitizeStats = (raw: unknown): SanitizedStats => {
  if (!raw || typeof raw !== 'object') return {};
  const clean: SanitizedStats = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'boolean' || val === null) {
      clean[key] = val;
      continue;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    const minAllowed = (key === 'fastestWinTurns' || key === 'fastestLossTurns') ? 1 : 0;
    clean[key] = Math.max(minAllowed, Math.min(Math.floor(n), STATS_VALUE_CAP));
  }
  return clean;
};
