/**
 * `npm audit --audit-level=high`, retried on a registry outage and on
 * nothing else.
 *
 * npm exits 1 both for a real advisory and for an advisory endpoint that
 * never answered, and a workflow step cannot tell the two apart. On
 * 2026-09-04 the endpoint (POST /-/npm/v1/security/advisories/bulk) flapped
 * for most of a day: three runs of ci.yml in a row went red at the audit
 * step with every code check green, while the same lockfile audited clean
 * from a machine the endpoint happened to answer. This wrapper reads npm's
 * own error line to tell the cases apart, retries the outage with a short
 * back-off, and fails an advisory on the first attempt so the retry can
 * never be what hides one.
 *
 * Plain Node, no dependencies: audit.yml runs it without an `npm ci`
 * (npm audit needs only the manifest and lockfile), so nothing under
 * node_modules can be assumed.
 *
 * Usage, from the directory whose lockfile is to be audited:
 *   node scripts/npm-audit-retry.mjs          (repo root)
 *   node ../scripts/npm-audit-retry.mjs       (server/)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const AUDIT_LEVEL = 'high';

/** Attempts in total, counting the first. */
export const AUDIT_ATTEMPTS = 3;
/** Back-off before the second and third attempt, in order. */
export const RETRY_DELAYS_MS = Object.freeze([30_000, 60_000]);

/**
 * Each attempt is bounded by npm's own fetch timeout, with npm's internal
 * retries switched off so this wrapper is the only thing retrying: three
 * bounded attempts plus the back-off stay inside the CI job's timeout, while
 * npm's defaults (5 min, 2 retries) did not. 180 s rather than 60 s because
 * the same outage also produced a successful answer after 105 s to first
 * byte for this repo's real payload.
 */
export const FETCH_TIMEOUT_MS = 180_000;
export const FETCH_RETRIES = 0;

/**
 * The line npm prints — after its own warnings about the timeout or the 5xx
 * it saw — when the advisory endpoint itself failed. Matched as a whole line
 * of npm's error stream, not as a substring: an advisory for a package whose
 * name contains these words must stay an advisory.
 */
const ENDPOINT_ERROR_LINE = /^npm error audit endpoint returned an error\s*$/m;

const CLEAN_EXIT_CODE = 0;

/** @typedef {{ status: number, output: string }} AuditRun */
/** @typedef {'clean' | 'advisory' | 'endpoint-error'} AuditOutcome */

/**
 * @param {AuditRun} run
 * @returns {AuditOutcome}
 */
export const classifyAuditOutcome = ({ status, output }) => {
  if (status === CLEAN_EXIT_CODE) return 'clean';
  return ENDPOINT_ERROR_LINE.test(output) ? 'endpoint-error' : 'advisory';
};

/**
 * Runs `audit` up to AUDIT_ATTEMPTS times, sleeping RETRY_DELAYS_MS[i]
 * between attempts, and only while the outcome is an endpoint error.
 *
 * @param {{ audit: () => AuditRun, sleep: (ms: number) => void, log: (line: string) => void }} deps
 * @returns {AuditOutcome} the last attempt's outcome
 */
export const auditWithRetry = ({ audit, sleep, log }) => {
  let outcome = /** @type {AuditOutcome} */ ('endpoint-error');
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
    const run = audit();
    log(run.output);
    outcome = classifyAuditOutcome(run);
    if (outcome !== 'endpoint-error') return outcome;
    const isLastAttempt = attempt === AUDIT_ATTEMPTS;
    if (isLastAttempt) break;
    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    log(`npm audit could not reach the advisory endpoint (attempt ${attempt} of ${AUDIT_ATTEMPTS}); retrying in ${delayMs / 1000}s`);
    sleep(delayMs);
  }
  return outcome;
};

const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** @returns {AuditRun} */
const runNpmAudit = () => {
  const result = spawnSync(
    NPM_COMMAND,
    [
      'audit',
      `--audit-level=${AUDIT_LEVEL}`,
      `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
      `--fetch-retries=${FETCH_RETRIES}`,
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  // A spawn failure (npm not on PATH) has no exit status at all; treat it as
  // a failed attempt whose output is the spawn error, which is an advisory
  // by the classifier's rules — i.e. it fails fast rather than retrying.
  const status = result.status ?? (result.error ? 1 : CLEAN_EXIT_CODE);
  return { status, output: result.error ? `${output}\n${result.error.message}` : output };
};

/** Synchronous so the whole wrapper stays a straight-line script. */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const EXIT_FAILURE = 1;

const main = () => {
  const outcome = auditWithRetry({ audit: runNpmAudit, sleep: sleepSync, log: line => console.log(line) });
  if (outcome === 'clean') return;
  if (outcome === 'endpoint-error') {
    console.error(`npm audit: the advisory endpoint did not answer in ${AUDIT_ATTEMPTS} attempts; failing the step`);
  }
  process.exit(EXIT_FAILURE);
};

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) main();
