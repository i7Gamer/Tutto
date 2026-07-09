export const STATS_VALUE_CAP = 1e9;

// A turn count of 0 is meaningless for these two fields (a game always takes
// at least 1 turn) — named here as the single source of truth for which
// fields get the stricter >= 1 floor instead of the default >= 0.
const MIN_ONE_STATS_FIELDS = new Set(['fastestWinTurns', 'fastestLossTurns']);

export type SanitizedStats = Record<string, number | boolean | null>;

export const sanitizeStats = (raw: unknown): SanitizedStats => {
  if (!raw || typeof raw !== 'object') return {};
  const clean: SanitizedStats = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'boolean' || val === null) {
      clean[key] = val;
      continue;
    }
    // Restricted to number/string before coercing — numeric strings ('3') are
    // legitimately accepted, but Number(val) on anything else can still
    // "succeed" via a type's own toString (e.g. Number([42]) === 42, via
    // Array.prototype.toString), letting a single-element array pass through
    // as a valid stat.
    if (typeof val !== 'number' && typeof val !== 'string') continue;
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    const minAllowed = MIN_ONE_STATS_FIELDS.has(key) ? 1 : 0;
    clean[key] = Math.max(minAllowed, Math.min(Math.floor(n), STATS_VALUE_CAP));
  }
  return clean;
};
