/** @vitest-environment node */
/**
 * Guards scripts/npm-audit-retry.mjs, the wrapper both audit workflows run
 * instead of a bare `npm audit`.
 *
 * On 2026-09-04 the registry's advisory endpoint flapped for most of a day:
 * every `npm audit` on the CI runner ended in a network timeout or a 503,
 * three re-runs in a row, while the same lockfile audited clean from a
 * machine the endpoint happened to answer. Each of those red runs blocked a
 * push that had passed every code check. The wrapper retries exactly that
 * failure and nothing else: a real advisory must still fail on the first
 * attempt, so the retry can never be the thing that hides one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyAuditOutcome,
  auditWithRetry,
  AUDIT_ATTEMPTS,
  RETRY_DELAYS_MS,
  type AuditRun,
} from '../scripts/npm-audit-retry.mjs';

const CLEAN_EXIT = 0;
const NPM_FAILURE_EXIT = 1;

// Verbatim from the CI logs of run 33850460966 and its two re-runs.
const ENDPOINT_TIMEOUT_OUTPUT = [
  'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
  'npm error audit endpoint returned an error',
].join('\n');
const ENDPOINT_503_OUTPUT = [
  'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable',
  "{ error: 'Service Unavailable' }",
  'npm error audit endpoint returned an error',
].join('\n');
const ADVISORY_OUTPUT = [
  'some-package  <1.2.3',
  'Severity: high',
  '1 high severity vulnerability',
  'To address all issues, run:',
  '  npm audit fix',
].join('\n');
const CLEAN_OUTPUT = 'found 0 vulnerabilities';

const run = (status: number, output: string): AuditRun => ({ status, output });

describe('classifyAuditOutcome', () => {
  it('reads a zero exit as clean whatever npm printed', () => {
    expect(classifyAuditOutcome(run(CLEAN_EXIT, CLEAN_OUTPUT))).toBe('clean');
  });

  it('reads a failed attempt with npm\'s endpoint-error marker as an endpoint error', () => {
    expect(classifyAuditOutcome(run(NPM_FAILURE_EXIT, ENDPOINT_TIMEOUT_OUTPUT))).toBe('endpoint-error');
    expect(classifyAuditOutcome(run(NPM_FAILURE_EXIT, ENDPOINT_503_OUTPUT))).toBe('endpoint-error');
  });

  it('reads a failed attempt without the marker as a real advisory', () => {
    expect(classifyAuditOutcome(run(NPM_FAILURE_EXIT, ADVISORY_OUTPUT))).toBe('advisory');
  });

  it('does not let a marker in an advisory package name turn a finding into a retry', () => {
    // The marker is npm's own error line, not a substring anywhere in the
    // output: an advisory for a package whose name or advisory title happens
    // to contain the words must still be a finding.
    const output = `${ADVISORY_OUTPUT}\nnetwork-timeout-utils  <2.0.0`;
    expect(classifyAuditOutcome(run(NPM_FAILURE_EXIT, output))).toBe('advisory');
  });
});

describe('auditWithRetry', () => {
  const setup = (runs: AuditRun[]) => {
    const audit = vi.fn<() => AuditRun>();
    runs.forEach(r => audit.mockReturnValueOnce(r));
    const sleep = vi.fn<(ms: number) => void>();
    const log = vi.fn<(line: string) => void>();
    return { audit, sleep, log };
  };

  it('returns clean on the first attempt without sleeping', () => {
    const { audit, sleep, log } = setup([run(CLEAN_EXIT, CLEAN_OUTPUT)]);

    expect(auditWithRetry({ audit, sleep, log })).toBe('clean');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails on a real advisory at the first attempt, never retrying it', () => {
    const { audit, sleep, log } = setup([
      run(NPM_FAILURE_EXIT, ADVISORY_OUTPUT),
      run(CLEAN_EXIT, CLEAN_OUTPUT),
    ]);

    expect(auditWithRetry({ audit, sleep, log })).toBe('advisory');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries an endpoint error with the configured back-off and succeeds when the endpoint recovers', () => {
    const { audit, sleep, log } = setup([
      run(NPM_FAILURE_EXIT, ENDPOINT_TIMEOUT_OUTPUT),
      run(NPM_FAILURE_EXIT, ENDPOINT_503_OUTPUT),
      run(CLEAN_EXIT, CLEAN_OUTPUT),
    ]);

    expect(auditWithRetry({ audit, sleep, log })).toBe('clean');
    expect(audit).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it('gives up after the configured number of attempts and reports the endpoint error', () => {
    const { audit, sleep, log } = setup(
      Array.from({ length: AUDIT_ATTEMPTS }, () => run(NPM_FAILURE_EXIT, ENDPOINT_TIMEOUT_OUTPUT)),
    );

    expect(auditWithRetry({ audit, sleep, log })).toBe('endpoint-error');
    expect(audit).toHaveBeenCalledTimes(AUDIT_ATTEMPTS);
    // One back-off between each pair of attempts, none after the last.
    expect(sleep).toHaveBeenCalledTimes(AUDIT_ATTEMPTS - 1);
  });

  it('still fails on an advisory that surfaces once the endpoint is back', () => {
    // The whole point: recovery must not read as "clean".
    const { audit, sleep, log } = setup([
      run(NPM_FAILURE_EXIT, ENDPOINT_503_OUTPUT),
      run(NPM_FAILURE_EXIT, ADVISORY_OUTPUT),
    ]);

    expect(auditWithRetry({ audit, sleep, log })).toBe('advisory');
    expect(audit).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('echoes every attempt\'s output so the CI log still shows what npm said', () => {
    const { audit, sleep, log } = setup([
      run(NPM_FAILURE_EXIT, ENDPOINT_TIMEOUT_OUTPUT),
      run(CLEAN_EXIT, CLEAN_OUTPUT),
    ]);

    auditWithRetry({ audit, sleep, log });

    const logged = log.mock.calls.map(([line]) => line).join('\n');
    expect(logged).toContain(ENDPOINT_TIMEOUT_OUTPUT);
    expect(logged).toContain(CLEAN_OUTPUT);
  });

  it('has as many back-off delays as gaps between attempts', () => {
    // A delays table shorter than the attempt count would throw or sleep
    // for undefined at the last retry; longer would be dead entries.
    expect(RETRY_DELAYS_MS).toHaveLength(AUDIT_ATTEMPTS - 1);
    RETRY_DELAYS_MS.forEach(ms => expect(ms).toBeGreaterThan(0));
  });
});
