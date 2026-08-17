/** @vitest-environment node */
/**
 * Guards the CI workflows' npm cache contract.
 *
 * This repository has TWO lockfiles — the root one and server/package-lock.json
 * — and every job installs from both. actions/setup-node keys its cache on the
 * lockfile it finds beside the working directory, so with no
 * cache-dependency-path a server-only dependency bump restores a cache keyed to
 * a root lockfile that never changed.
 *
 * Nothing fails when that happens; the cache is merely wrong, and a wrong cache
 * is invisible in a green run. That is the whole reason this is a test rather
 * than something a reviewer is expected to notice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const SETUP_NODE_ACTION = 'actions/setup-node';
const NPM_CACHE = 'npm';

// node_modules holds a lockfile per nested dependency; none of them is ours.
const NOT_OUR_LOCKFILES = 'node_modules';

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflowFiles = (): string[] =>
  fs.readdirSync(WORKFLOWS_DIR).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));

/** Every setup-node step that asks for npm caching, across every workflow. */
const npmCachingSteps = (): { file: string; job: string; step: WorkflowStep }[] =>
  workflowFiles().flatMap(file => {
    const workflow = parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')) as Workflow;
    return Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .filter(step => step.uses?.startsWith(SETUP_NODE_ACTION) && step.with?.cache === NPM_CACHE)
        .map(step => ({ file, job, step })),
    );
  });

/** Repo-relative paths of the lockfiles the workflows actually install from. */
const ourLockfiles = (): string[] =>
  fs
    .globSync('**/package-lock.json', {
      cwd: REPO_ROOT,
      exclude: (entry: string) => entry.split(/[\\/]/)[0] === NOT_OUR_LOCKFILES,
    })
    .map(match => match.split(path.sep).join('/'))
    .sort();

/** What a declared cache-dependency-path resolves to on this checkout. */
const expandDependencyPath = (declared: string): string[] =>
  declared
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .flatMap(pattern =>
      fs
        .globSync(pattern, {
          cwd: REPO_ROOT,
          exclude: (entry: string) => entry.split(/[\\/]/)[0] === NOT_OUR_LOCKFILES,
        })
        .map(match => match.split(path.sep).join('/')),
    );

describe('workflow npm caches key on every lockfile', () => {
  it('finds the setup-node steps it is meant to be checking', () => {
    // Without this, a renamed action or a restructured workflow would make the
    // assertions below pass by inspecting nothing at all.
    expect(npmCachingSteps().length).toBeGreaterThan(0);
  });

  it('knows about more than one lockfile', () => {
    // The premise of the whole file. If the server workspace ever collapses
    // into the root one, these checks stop being worth their weight.
    expect(ourLockfiles().length).toBeGreaterThan(1);
  });

  it('declares a cache-dependency-path wherever npm caching is enabled', () => {
    const undeclared = npmCachingSteps()
      .filter(({ step }) => typeof step.with?.['cache-dependency-path'] !== 'string')
      .map(({ file, job }) => `${file}: ${job}`);

    expect(undeclared).toEqual([]);
  });

  it('covers every lockfile the repository installs from', () => {
    const lockfiles = ourLockfiles();
    const uncovered = npmCachingSteps()
      .map(({ file, job, step }) => {
        const declared = String(step.with?.['cache-dependency-path'] ?? '');
        const covered = new Set(expandDependencyPath(declared));
        return { file, job, missing: lockfiles.filter(lockfile => !covered.has(lockfile)) };
      })
      .filter(({ missing }) => missing.length > 0)
      .map(({ file, job, missing }) => `${file}: ${job} misses ${missing.join(', ')}`);

    expect(uncovered).toEqual([]);
  });
});
