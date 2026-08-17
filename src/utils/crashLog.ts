// Crash telemetry for the ErrorBoundary auto-reload flow. The boundary clears
// caches and reloads on the first render crash, which would otherwise destroy
// every trace of what went wrong. Each crash is appended to localStorage
// (which survives the reload — clearCacheAndReload only removes specific keys)
// and fire-and-forget POSTed to the server so crashes on other players'
// devices show up in the server log. Offline/PWA play still gets the
// localStorage entry.

import { localStore } from './storage';

export const CRASH_LOG_KEY = 'tutto_crash_log';
const MAX_ENTRIES = 5;
const MAX_FIELD_LENGTH = 2000;

export interface CrashLogEntry {
  message: string;
  stack: string;
  componentStack: string;
  timestamp: string;
}

const truncate = (value: unknown): string => String(value ?? '').slice(0, MAX_FIELD_LENGTH);

// JSON.stringify throws on a circular structure, and the values reaching this
// module are not all Errors: an unhandled rejection carries whatever the code
// rejected with, and a DOM Event references its own target. That throw used to
// escape recordCrash (buildCrashEntry is called outside both of its try
// blocks) and therefore ErrorBoundary.componentDidCatch — the crash reporter
// took the app down at the one moment it exists to keep it up. Dropping the
// repeated reference keeps the rest of the object readable, which a bare
// try/catch fallback to String(error) ("[object Object]") would not.
const safeStringify = (value: object): string => {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val !== 'object' || val === null) return val;
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      return val;
    }) ?? String(value);
  } catch {
    // Still reachable without a cycle: a BigInt throws, and a getter or a
    // toJSON() on the thrown value runs arbitrary app code that can itself
    // throw. Never let the reporter be the thing that fails.
    return String(value);
  }
};

export const buildCrashEntry = (error: unknown, componentStack?: string | null): CrashLogEntry => ({
  message: truncate(
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
      ? safeStringify(error)
      : error
  ),
  stack: truncate(error instanceof Error ? error.stack : ''),
  componentStack: truncate(componentStack),
  timestamp: new Date().toISOString(),
});

export const readCrashLog = (): CrashLogEntry[] => {
  try {
    const parsed: unknown = JSON.parse(localStore.read(CRASH_LOG_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as CrashLogEntry[]) : [];
  } catch {
    return [];
  }
};

export const recordCrash = (error: unknown, componentStack?: string | null): void => {
  const entry = buildCrashEntry(error, componentStack);
  try {
    const log = [...readCrashLog(), entry].slice(-MAX_ENTRIES);
    localStore.write(CRASH_LOG_KEY, JSON.stringify(log));
  } catch {
    // Quota exceeded or storage unavailable — losing the local copy must
    // never block the recovery reload.
  }
  try {
    // keepalive lets the request outlive the imminent page reload.
    void fetch('/api/log/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fetch unavailable or synchronously rejected — the localStorage entry
    // above is the fallback record.
  }
};

// Called once at startup: surfaces the most recent stored crash in the console
// so a devtools user can see why the app just auto-reloaded.
export const warnAboutRecentCrash = (): void => {
  const log = readCrashLog();
  const last = log[log.length - 1];
  if (last) {
    // readCrashLog only checks that the parsed JSON is an array, not that each
    // element actually has the CrashLogEntry shape — an older/foreign entry
    // could be missing these fields entirely.
    console.warn(
      `[tutto] ${log.length} stored crash report(s); most recent at ${last?.timestamp ?? '(unknown time)'}: ${last?.message ?? '(unknown)'}`,
      last,
    );
  }
};
