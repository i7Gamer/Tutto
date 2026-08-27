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
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
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

/**
 * `npm ci` in the repository root runs the root postinstall, which is
 * `cd server && npm install` — and `npm install` REPAIRS a package.json /
 * lockfile disagreement by rewriting the lockfile on the runner.
 *
 * The step after it runs `npm ci` in server/, whose whole safety property is
 * aborting on exactly that disagreement. Run second, it validates a lockfile
 * the first step has already fixed, and the server `npm audit` then audits the
 * rewritten file. Nothing wrong ships — the Dockerfile builder fails closed
 * with EUSAGE, which it does by passing this same flag — so the cost is a
 * release build breaking after a green CI.
 */
describe('the credentialed publish workflow pins its actions by commit', () => {
  // docker-publish.yml is the only workflow that holds registry credentials
  // and pushes an image the world then pulls. A mutable major tag means the
  // code it runs with those credentials is whatever the action's owner most
  // recently moved v5 to -- a decision taken in someone else's repository,
  // after review here, with no signal that anything changed.
  //
  // Pinning alone would trade a supply-chain risk for a staleness one, so it
  // arrives with .github/dependabot.yml watching the github-actions ecosystem:
  // updates then land as reviewable pull requests instead of silently.
  //
  // Deliberately scoped to this one workflow. ci.yml and audit.yml run on the
  // same commits but hold nothing, and pinning every workflow would multiply
  // the dependabot noise for no reduction in blast radius.
  const CREDENTIALED_WORKFLOW = 'docker-publish.yml';
  const COMMIT_PINNED = /@[0-9a-f]{40}$/;
  // A workflow calling another workflow in THIS repository — already pinned by
  // definition, since it is the very commit under test.
  const LOCAL_REUSABLE = './';

  const usesInCredentialedWorkflow = (): { job: string; uses: string }[] => {
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, CREDENTIALED_WORKFLOW), 'utf8');
    return Object.entries(parseWorkflow(source).jobs ?? {}).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .map(step => step.uses)
        .filter((uses): uses is string => !!uses && !uses.startsWith(LOCAL_REUSABLE))
        .map(uses => ({ job, uses })),
    );
  };

  it('finds the third-party actions it is meant to be checking', () => {
    // The self-oracle: matching nothing must not read as everything passing.
    expect(usesInCredentialedWorkflow().length).toBeGreaterThan(0);
  });

  it('uses no mutable tag for any third-party action', () => {
    const mutable = usesInCredentialedWorkflow()
      .filter(({ uses }) => !COMMIT_PINNED.test(uses))
      .map(({ job, uses }) => `${job}: ${uses}`);

    expect(mutable, 'these run with registry credentials at whatever their owner last moved the tag to').toEqual([]);
  });

  it('keeps dependabot watching the actions it just froze', () => {
    // Without this the pins rot: a security fix in an action would never
    // reach the one workflow that most needs it.
    const config = parseWorkflow(fs.readFileSync(path.join(REPO_ROOT, '.github', 'dependabot.yml'), 'utf8')) as
      unknown as { updates?: { 'package-ecosystem'?: string }[] };
    const ecosystems = (config.updates ?? []).map(entry => entry['package-ecosystem']);

    expect(ecosystems).toContain('github-actions');
  });
});

describe('every job that runs the suite has built first', () => {
  // src/utils/serviceWorkerConfig.test.ts is `describe.skipIf(!existsSync(
  // 'dist/sw.js'))`, and it is the ONLY guard on the shipped service worker —
  // the file whose own header documents at length how badly a bundled worker
  // can fail. ci.yml builds before it tests, so the guard runs there; the
  // workflow that actually PUBLISHES did not, so the whole suite skipped and
  // the release was gated by a green check that had inspected nothing.
  //
  // Keyed off which scripts actually run vitest, read from package.json rather
  // than hard-coded: `test:e2e` also starts with "npm run test" but is a
  // different suite that builds inside playwright.config.ts's own webServer,
  // and `test:publish-cleanup` is a shell harness. Derived, so a renamed or
  // added vitest script is covered without editing this list.
  const BUILD_SCRIPT = 'npm run build';

  const vitestScripts = (): string[] => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    return Object.entries(scripts)
      .filter(([, command]) => command.includes('vitest'))
      .map(([name]) => `npm run ${name}`);
  };

  const runsVitest = (step: WorkflowStep): boolean => {
    const command = step.run?.trim() ?? '';
    return vitestScripts().some(script => command === script || command.startsWith(`${script} `));
  };

  const suiteJobs = (): { file: string; job: string; steps: WorkflowStep[] }[] =>
    workflowFiles().flatMap(file => {
      const workflow = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
      return Object.entries(workflow.jobs ?? {})
        .filter(([, definition]) => (definition.steps ?? []).some(runsVitest))
        .map(([job, definition]) => ({ file, job, steps: definition.steps ?? [] }));
    });

  it('finds the suite-running jobs it is meant to be checking', () => {
    // The self-oracle every check in this file carries: matching nothing must
    // not read as everything passing.
    expect(vitestScripts().length).toBeGreaterThan(0);
    expect(suiteJobs().length).toBeGreaterThan(0);
  });

  it('builds before running the suite, so the service-worker guard is not skipped', () => {
    const unbuilt = suiteJobs()
      .filter(({ steps }) => {
        const buildAt = steps.findIndex(step => step.run?.trim().startsWith(BUILD_SCRIPT));
        const testAt = steps.findIndex(runsVitest);
        return buildAt === -1 || buildAt > testAt;
      })
      .map(({ file, job }) => `${file}:${job}`);

    expect(unbuilt, 'these jobs run the suite without dist/, so the service-worker tests silently skip').toEqual([]);
  });
});

describe('a root install cannot quietly repair the server lockfile', () => {
  /** Every `run:` step across every workflow, with where it runs. */
  const runSteps = (): { file: string; job: string; step: WorkflowStep }[] =>
    workflowFiles().flatMap(file => {
      const workflow = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
      return Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
        (definition.steps ?? []).filter(step => typeof step.run === 'string').map(step => ({ file, job, step })),
      );
    });

  /** The `npm ci` steps that run in the repository root, where postinstall fires. */
  const rootNpmCiSteps = () =>
    runSteps().filter(({ step }) =>
      /(?:^|\n)\s*npm ci\b/.test(step.run!) && !step['working-directory'],
    );

  it('finds the root npm ci steps it is meant to be checking', () => {
    // Without this the suite would pass by finding nothing — the shape of a
    // check that has quietly stopped checking.
    expect(rootNpmCiSteps().length).toBeGreaterThan(0);
  });

  it('runs every root npm ci with --ignore-scripts', () => {
    const unguarded = rootNpmCiSteps()
      .filter(({ step }) => !step.run!.includes('--ignore-scripts'))
      .map(({ file, job }) => `${file}:${job}`);

    expect(unguarded).toEqual([]);
  });

  it('is guarding a postinstall that really does install into server/', () => {
    // If the root postinstall ever stops touching server/, the flag above is
    // pointless ceremony and this says so.
    const postinstall = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ).scripts?.postinstall ?? '';

    expect(postinstall).toMatch(/server/);
    expect(postinstall).toMatch(/npm install/);
  });
});
