/**
 * Types for scripts/npm-audit-retry.mjs, so server/npmAuditRetry.test.ts can
 * import it under tsconfig.test.json (which has no allowJs — the script is
 * plain Node because audit.yml runs it without an `npm ci`).
 */
export interface AuditRun {
  status: number;
  output: string;
}

export type AuditOutcome = 'clean' | 'advisory' | 'endpoint-error';

export const AUDIT_LEVEL: string;
export const AUDIT_ATTEMPTS: number;
export const RETRY_DELAYS_MS: readonly number[];
export const FETCH_TIMEOUT_MS: number;
export const FETCH_RETRIES: number;

export function classifyAuditOutcome(run: AuditRun): AuditOutcome;

export function auditWithRetry(deps: {
  audit: () => AuditRun;
  sleep: (ms: number) => void;
  log: (line: string) => void;
}): AuditOutcome;
