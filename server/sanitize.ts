export const STATS_VALUE_CAP = 1e9;

// Indent prepended to continuation lines of multi-line log fields — see
// indentLogContinuationLines.
const LOG_CONTINUATION_INDENT = '    ';

// For client-supplied values interpolated into a log entry's HEADER line
// (e.g. the crash report's timestamp/message): embedded CR/LF would let a
// crafted value forge entirely fake log entries.
export const sanitizeLogHeaderField = (value: string): string => value.replace(/[\r\n]+/g, ' ');

// For legitimately multi-line log fields (stack traces): keeps the newlines
// but indents every continuation line, so no embedded line can masquerade as
// a fresh top-level log entry (e.g. a forged "[client-error] ..." line).
export const indentLogContinuationLines = (value: string): string =>
  value.replace(/\r\n|\r|\n/g, `\n${LOG_CONTINUATION_INDENT}`);

// A turn count of 0 is meaningless for these two fields (a game always takes
// at least 1 turn) — named here as the single source of truth for which
// fields get the stricter >= 1 floor instead of the default >= 0.
const MIN_ONE_STATS_FIELDS = new Set(['fastestWinTurns', 'fastestLossTurns']);

// Modernized rules keep Plus/Minus deductions unclamped (see the engine's
// deliberate no-clamp comment), so a player can legitimately FINISH a game
// below zero — flooring their totalScore at 0 silently inflated every sum
// and average built on it. Counters and records stay non-negative.
const NEGATIVE_ALLOWED_STATS_FIELDS = new Set(['totalScore']);

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
    const minAllowed = MIN_ONE_STATS_FIELDS.has(key) ? 1
      : NEGATIVE_ALLOWED_STATS_FIELDS.has(key) ? -STATS_VALUE_CAP
        : 0;
    clean[key] = Math.max(minAllowed, Math.min(Math.floor(n), STATS_VALUE_CAP));
  }
  return clean;
};
