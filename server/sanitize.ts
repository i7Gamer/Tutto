export const STATS_VALUE_CAP = 1e9;

// Indent prepended to continuation lines of multi-line log fields — see
// indentLogContinuationLines.
const LOG_CONTINUATION_INDENT = '    ';

// ANSI CSI sequences. Not just colour: CUU/EL (ESC[1A ESC[2K) move the cursor
// onto log lines ALREADY written and blank them, so a crafted field can erase
// or overwrite genuine entries in a live terminal without ever emitting a
// newline of its own — which is all the CR/LF handling below can stop.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// The remaining control characters a log reader acts on rather than prints: a
// NUL truncates the line in several log processors, and BEL, backspace and a
// bare ESC survive the CSI pattern above. CR (\x0d) and LF (\x0a) are excluded
// — each function below has its own rule for them — and so is tab (\x09),
// which cannot forge an entry and whose removal would mangle legitimately
// tab-separated messages.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const LOG_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const stripLogControlChars = (value: string): string =>
  value.replace(ANSI_ESCAPE, '').replace(LOG_CONTROL_CHARS, '');

// For client-supplied values interpolated into a log entry's HEADER line
// (e.g. the crash report's timestamp/message): embedded CR/LF would let a
// crafted value forge entirely fake log entries.
export const sanitizeLogHeaderField = (value: string): string =>
  stripLogControlChars(value).replace(/[\r\n]+/g, ' ');

// For legitimately multi-line log fields (stack traces): keeps the newlines
// but indents every continuation line, so no embedded line can masquerade as
// a fresh top-level log entry (e.g. a forged "[client-error] ..." line). Just
// as client-supplied as the header fields and bound for the same log, so it
// gets the same escape stripping — indenting a line does nothing about an
// ANSI sequence inside it.
export const indentLogContinuationLines = (value: string): string =>
  stripLogControlChars(value).replace(/\r\n|\r|\n/g, `\n${LOG_CONTINUATION_INDENT}`);

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
