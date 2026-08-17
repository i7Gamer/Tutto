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

// A dependency tree may ship a package-lock.json of its own inside a published
// tarball; none of those is a lockfile this repository installs from.
const NODE_MODULES = 'node_modules';

const LOCKFILE_GLOB = '**/package-lock.json';

/**
 * Whether a repo-relative path lives inside a dependency tree.
 *
 * ANY segment, not just the first: this repository always has
 * server/node_modules as well as the root one.
 */
const isInsideNodeModules = (candidate: string): boolean =>
  candidate.split(/[\\/]/).includes(NODE_MODULES);

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

/** A workflow document, or an empty one when the file carries no YAML. */
const parseWorkflow = (source: string): Workflow => (parse(source) as Workflow | null) ?? {};

/** Every setup-node step that asks for npm caching, across every workflow. */
const npmCachingSteps = (): { file: string; job: string; step: WorkflowStep }[] =>
  workflowFiles().flatMap(file => {
    const workflow = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
    return Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .filter(step => step.uses?.startsWith(SETUP_NODE_ACTION) && step.with?.cache === NPM_CACHE)
        .map(step => ({ file, job, step })),
    );
  });

/** Repo-relative matches for a glob, dependency trees excluded. */
const globRepo = (pattern: string): string[] =>
  fs
    .globSync(pattern, { cwd: REPO_ROOT, exclude: isInsideNodeModules })
    .map(match => match.split(path.sep).join('/'));

/** Repo-relative paths of the lockfiles the workflows actually install from. */
const ourLockfiles = (): string[] => globRepo(LOCKFILE_GLOB).sort();

/** What a declared cache-dependency-path resolves to on this checkout. */
const expandDependencyPath = (declared: string): string[] =>
  declared
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .flatMap(globRepo);

describe('the helpers these checks are built on', () => {
  it('counts a vendored lockfile as the dependency tree\'s, not ours', () => {
    // Checking only the FIRST path segment misses server/node_modules, which
    // this repository always has. An explicit cache-dependency-path would then
    // be reported as "missing" a lockfile shipped inside some dependency's
    // published tarball, and the workflow told to key its cache on it.
    expect(isInsideNodeModules('node_modules/foo/package-lock.json')).toBe(true);
    expect(isInsideNodeModules('server/node_modules/foo/package-lock.json')).toBe(true);

    expect(isInsideNodeModules('package-lock.json')).toBe(false);
    expect(isInsideNodeModules('server/package-lock.json')).toBe(false);
    // Segment-wise, not a substring: a directory merely NAMED like one is ours.
    expect(isInsideNodeModules('server/node_modules_backup/package-lock.json')).toBe(false);
  });

  it('reads a workflow with no YAML content as having no jobs', () => {
    // yaml's parse() answers null for an empty or comment-only document, and
    // `?? {}` on .jobs cannot save a null document from being dereferenced —
    // a placeholder file in .github/workflows/ would turn every assertion
    // below into an unrelated TypeError.
    expect(parseWorkflow('').jobs).toBeUndefined();
    expect(parseWorkflow('# not written yet\n').jobs).toBeUndefined();
  });
});

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
