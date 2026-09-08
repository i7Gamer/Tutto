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
import playwrightConfig from '../playwright.config';

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const SETUP_NODE_ACTION = 'actions/setup-node';
const NPM_CACHE = 'npm';

// A dependency tree may ship a package-lock.json of its own inside a published
// tarball; none of those is a lockfile this repository installs from.
const NODE_MODULES = 'node_modules';

const LOCKFILE_GLOB = '**/package-lock.json';

const DEPENDABOT_FILE = path.join(REPO_ROOT, '.github', 'dependabot.yml');
const EXPECTED_DEPENDABOT_VERSION = 2;
const EXPECTED_OPEN_PR_LIMIT = 5;
const EXPECTED_WEEKLY_SCHEDULE_DAY = 'monday';
const WEEKLY_INTERVAL = 'weekly';
const VALID_SCHEDULE_INTERVALS = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannually', 'yearly'];

/**
 * Whether a repo-relative path lives inside a dependency tree.
 *
 * ANY segment, not just the first: this repository always has
 * server/node_modules as well as the root one.
 */
const isInsideNodeModules = (candidate: string): boolean =>
  candidate.split(/[\\/]/).includes(NODE_MODULES);

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}

interface MatrixInclude {
  project?: string;
  shard_index?: number;
  shard_total?: number;
}

interface WorkflowStrategy {
  matrix?: Record<string, unknown> & { include?: MatrixInclude[] };
  'fail-fast'?: boolean;
}

/**
 * A `permissions:` declaration: the shorthand strings, or a per-scope map.
 * A map is exhaustive — every scope it does not name is granted `none`.
 */
type Permissions = string | Record<string, string>;

interface WorkflowJob {
  name?: string;
  uses?: string;
  permissions?: Permissions;
  steps?: WorkflowStep[];
  strategy?: WorkflowStrategy;
  'timeout-minutes'?: number;
}

interface WorkflowConcurrency {
  group?: string;
  'cancel-in-progress'?: boolean;
}

interface Workflow {
  permissions?: Permissions;
  jobs?: Record<string, WorkflowJob>;
  concurrency?: WorkflowConcurrency;
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

describe('dependabot configuration covers all ecosystems in the repository', () => {
  interface DependabotUpdateEntry {
    'package-ecosystem'?: string;
    directory?: string;
    directories?: string[];
    schedule?: { interval?: string; day?: string };
    'open-pull-requests-limit'?: number;
    groups?: Record<string, unknown>;
    'commit-message'?: { prefix?: string };
  }

  interface DependabotConfig {
    version?: number;
    updates?: DependabotUpdateEntry[];
  }

  const loadDependabotConfig = (): DependabotConfig => {
    const raw = fs.readFileSync(DEPENDABOT_FILE, 'utf8');
    return (parse(raw) as DependabotConfig | null) ?? {};
  };

  it('declares version 2 configuration', () => {
    const config = loadDependabotConfig();
    expect(config.version).toBe(EXPECTED_DEPENDABOT_VERSION);
  });

  it('covers root npm, server npm, docker, and github-actions ecosystems', () => {
    const config = loadDependabotConfig();
    const updates = config.updates ?? [];

    const rootNpm = updates.find(
      u => u['package-ecosystem'] === 'npm' && (u.directory === '/' || u.directories?.includes('/')),
    );
    expect(rootNpm).toBeDefined();

    const serverNpm = updates.find(
      u => u['package-ecosystem'] === 'npm' && (u.directory === '/server' || u.directories?.includes('/server')),
    );
    expect(serverNpm).toBeDefined();

    const docker = updates.find(
      u => u['package-ecosystem'] === 'docker' && (u.directory === '/' || u.directories?.includes('/')),
    );
    expect(docker).toBeDefined();

    const actions = updates.find(
      u => u['package-ecosystem'] === 'github-actions' && (u.directory === '/' || u.directories?.includes('/')),
    );
    expect(actions).toBeDefined();
  });

  it('configures schedule, groups, commit prefixes, and PR limits on every update entry', () => {
    const config = loadDependabotConfig();
    const updates = config.updates ?? [];
    expect(updates.length).toBeGreaterThan(0);

    for (const entry of updates) {
      expect(entry.schedule?.interval).toBeDefined();
      expect(VALID_SCHEDULE_INTERVALS).toContain(entry.schedule?.interval);
      if (entry.schedule?.interval === WEEKLY_INTERVAL) {
        expect(entry.schedule?.day).toBe(EXPECTED_WEEKLY_SCHEDULE_DAY);
      }
      expect(entry['open-pull-requests-limit']).toBe(EXPECTED_OPEN_PR_LIMIT);
      expect(entry.groups).toBeDefined();
      expect(Object.keys(entry.groups ?? {}).length).toBeGreaterThan(0);
      expect(entry['commit-message']?.prefix).toBeDefined();
    }
  });
});

describe('the test suites are type-checked in CI', () => {
  // tsconfig.test.json existed for weeks as a report nobody had to read:
  // 1486 errors, "not yet a gate". Once the typed fixtures brought it to zero
  // the only way to keep it there is to fail the build on the first new one.
  const CI_WORKFLOW = path.join(WORKFLOWS_DIR, 'ci.yml');
  // Anchored at end of line so the production step does not also match the
  // test step (its command is a prefix of the other).
  const PRODUCTION_TYPE_CHECK = /run: npm run type-check$/m;
  const TEST_TYPE_CHECK = /run: npm run type-check:test$/m;

  it('ci.yml runs type-check:test right after the production type-check', () => {
    const yaml = fs.readFileSync(CI_WORKFLOW, 'utf8');
    const production = yaml.search(PRODUCTION_TYPE_CHECK);
    const tests = yaml.search(TEST_TYPE_CHECK);
    expect(production, 'the production type-check step is the anchor').toBeGreaterThan(-1);
    expect(tests, 'the test type-check must be a CI step').toBeGreaterThan(-1);
    expect(tests, 'and it runs after the production one').toBeGreaterThan(production);
  });

  it('tsconfig.test.json no longer calls itself a non-gate', () => {
    const header = fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.test.json'), 'utf8');
    expect(header).not.toMatch(/NOT YET A GATE/);
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

/**
 * publish-latest.yml tags the image `latest,<package.json version>` at
 * whatever commit the dispatch resolves (master, by convention). Nothing
 * checked that resolved commit was actually the release: master routinely
 * sits dozens of commits ahead of its last version tag while package.json
 * still reads the old version, so a dispatch would silently republish that
 * old tag's number under a brand new build. This guards the invariant
 * instead of trusting whoever clicks "Run workflow" to remember it.
 */
describe('publish-latest fails closed unless HEAD is the release tag', () => {
  const PUBLISH_LATEST_WORKFLOW = 'publish-latest.yml';
  const VERSION_JOB = 'version';
  const PUBLISH_JOB = 'publish';

  // What the guard step's `run` body must contain: the exact-match check
  // against HEAD, and a comparison against the version read out of
  // package.json (not a hardcoded string, which would rot the moment the
  // version changes).
  const EXACT_MATCH_GUARD_PATTERN = /git describe --tags --exact-match HEAD/;
  const VERSION_COMPARISON_PATTERN = /require\(['"]\.\/package\.json['"]\)\.version/;

  const loadPublishLatestWorkflow = (): Workflow =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, PUBLISH_LATEST_WORKFLOW), 'utf8'));

  const versionJobSteps = (): WorkflowStep[] => loadPublishLatestWorkflow().jobs?.[VERSION_JOB]?.steps ?? [];

  const findGuardStep = (): WorkflowStep | undefined =>
    versionJobSteps().find(step => EXACT_MATCH_GUARD_PATTERN.test(step.run ?? ''));

  it('finds the version job it is meant to be checking', () => {
    // The self-oracle: matching nothing must not read as everything passing.
    expect(versionJobSteps().length).toBeGreaterThan(0);
  });

  it('fetches tags on checkout, so git describe can see the release tag', () => {
    const checkout = versionJobSteps().find(step => step.uses?.startsWith('actions/checkout'));
    expect(checkout, 'expected the version job to check out the repository').toBeDefined();

    const checkoutWith = (checkout?.with ?? {}) as Record<string, unknown>;
    const fetchesTags = checkoutWith['fetch-tags'] === true || checkoutWith['fetch-depth'] === 0;
    expect(
      fetchesTags,
      'checkout needs fetch-tags: true or fetch-depth: 0, or `git describe --tags` never sees the release tag',
    ).toBe(true);
  });

  it('has a step that refuses to proceed unless HEAD is exactly the release tag', () => {
    const guard = findGuardStep();
    expect(
      guard,
      'expected a step comparing `git describe --tags --exact-match HEAD` against v<package.json version>',
    ).toBeDefined();
    expect(guard?.run).toMatch(VERSION_COMPARISON_PATTERN);
  });

  it('fails the guard loudly: a non-zero exit behind an ::error:: annotation', () => {
    const guard = findGuardStep();
    expect(guard?.run).toMatch(/::error::/);
    expect(guard?.run).toMatch(/exit 1/);
  });

  it('runs the guard before the publish job — which is where the build/login steps live', () => {
    // build/login happen in docker-publish.yml's `build` job, reached only
    // through the `publish` job below. `publish` needs `version`, so putting
    // the guard anywhere in `version` puts it before every build/login step
    // without having to reach into the reusable workflow.
    const publishJob = loadPublishLatestWorkflow().jobs?.[PUBLISH_JOB] as { needs?: string | string[] } | undefined;
    const needs = ([] as string[]).concat(publishJob?.needs ?? []);
    expect(needs).toContain(VERSION_JOB);

    expect(findGuardStep(), 'the guard must live in the version job, which publish depends on').toBeDefined();
  });
});

/**
 * Before this, an accidental double-push or a force-push-then-push could run
 * two ci.yml instances for the same branch concurrently, each burning its own
 * Actions minutes toward a result only the later one matters for, and a stuck
 * step had no ceiling at all. A run of the `ci` job takes about 6 minutes
 * today and `e2e` about 9; the caps below leave headroom for legitimate
 * variance while still bounding a hang or a runaway matrix.
 */
describe('ci.yml is bound in time and concurrency', () => {
  // Named per the comment above rather than left as bare numbers in the YAML.
  const CI_JOB_TIMEOUT_MINUTES = 25;
  const E2E_JOB_TIMEOUT_MINUTES = 30;
  const CI_WORKFLOW = 'ci.yml';

  const loadCiWorkflow = (): Workflow =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, CI_WORKFLOW), 'utf8'));

  it('finds the jobs it is meant to be checking', () => {
    // The self-oracle: matching nothing must not read as everything passing.
    expect(Object.keys(loadCiWorkflow().jobs ?? {})).toEqual(expect.arrayContaining(['ci', 'e2e']));
  });

  it('cancels a superseded run instead of queuing behind it', () => {
    const { concurrency } = loadCiWorkflow();
    expect(concurrency?.group).toBe('ci-${{ github.ref }}');
    expect(concurrency?.['cancel-in-progress']).toBe(true);
  });

  it('bounds every job with timeout-minutes', () => {
    const jobs = loadCiWorkflow().jobs ?? {};
    const missing = Object.entries(jobs)
      .filter(([, definition]) => typeof definition['timeout-minutes'] !== 'number')
      .map(([job]) => job);

    expect(missing, 'every job needs an explicit ceiling or a hang runs until GitHub kills it').toEqual([]);
    expect(jobs.ci?.['timeout-minutes']).toBe(CI_JOB_TIMEOUT_MINUTES);
    expect(jobs.e2e?.['timeout-minutes']).toBe(E2E_JOB_TIMEOUT_MINUTES);
  });
});

/**
 * docker-publish.yml's `verify` job runs the unit suite but never the e2e one,
 * so an image could publish with a broken client the unit tests cannot see —
 * ci.yml's `e2e` job is what normally catches that class of bug, and nothing
 * here re-ran it before shipping. The chromium-only restriction mirrors why
 * ci.yml itself only runs firefox/webkit as part of the full three-browser e2e
 * job: this is a pre-publish gate, not the place to re-run the full matrix
 * ci.yml already covers on every push.
 */
describe('docker-publish.yml verify job also runs the e2e suite', () => {
  const VERIFY_JOB_TIMEOUT_MINUTES = 40;
  const CHROMIUM_PROJECT_FLAG = '--project=chromium';
  const DOCKER_PUBLISH_WORKFLOW = 'docker-publish.yml';
  const VERIFY_JOB = 'verify';
  const UNIT_TEST_STEP = 'npm run test';

  const loadDockerPublishWorkflow = (): Workflow =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, DOCKER_PUBLISH_WORKFLOW), 'utf8'));

  const verifyJob = (): WorkflowJob | undefined => loadDockerPublishWorkflow().jobs?.[VERIFY_JOB];

  it('finds the verify job it is meant to be checking', () => {
    // The self-oracle: matching nothing must not read as everything passing.
    expect(verifyJob()?.steps?.length ?? 0).toBeGreaterThan(0);
  });

  it('bounds the verify job with timeout-minutes', () => {
    expect(verifyJob()?.['timeout-minutes']).toBe(VERIFY_JOB_TIMEOUT_MINUTES);
  });

  it('installs the chromium browser after the unit tests run', () => {
    const steps = verifyJob()?.steps ?? [];
    const unitTestAt = steps.findIndex(step => step.run?.trim() === UNIT_TEST_STEP);
    const installAt = steps.findIndex(
      step => !!step.run?.includes('playwright install') && step.run.includes('chromium'),
    );

    expect(unitTestAt, 'expected to find the existing unit-test step as an anchor').toBeGreaterThan(-1);
    expect(installAt, 'expected a playwright install step scoped to chromium').toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(unitTestAt);
  });

  it('runs the e2e suite restricted to the chromium project', () => {
    const steps = verifyJob()?.steps ?? [];
    const e2eStep = steps.find(step => step.run?.includes('test:e2e'));

    expect(e2eStep, 'expected a step running the test:e2e script').toBeDefined();
    expect(e2eStep?.run).toContain(CHROMIUM_PROJECT_FLAG);
  });
});

/**
 * ci.yml also gates on two checks `verify` never ran: `type-check:test` (the
 * test suites' own tsconfig.test.json project — see 'the test suites are
 * type-checked in CI' above) and `test:publish-cleanup` (this same workflow's
 * Hub-cleanup steps, exercised against a stubbed API — see
 * scripts/test-publish-cleanup/run.sh). Neither needs anything verify lacks:
 * type-check:test is a local tsc invocation, and test:publish-cleanup
 * fabricates its own dummy Docker Hub credentials and stubs curl/jq so it
 * never reaches the real registry — it does not need the secrets `build`
 * holds and `verify` does not (M-10).
 */
describe('docker-publish.yml verify job runs every check ci.yml gates on (M-10)', () => {
  const CI_WORKFLOW = 'ci.yml';
  const DOCKER_PUBLISH_WORKFLOW = 'docker-publish.yml';
  const CI_JOB = 'ci';
  const VERIFY_JOB = 'verify';

  const loadWorkflow = (file: string): Workflow =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));

  const stepsOf = (file: string, job: string): WorkflowStep[] => loadWorkflow(file).jobs?.[job]?.steps ?? [];

  const hasRunStep = (steps: WorkflowStep[], script: string): boolean =>
    steps.some(step => step.run?.trim() === `npm run ${script}` || step.run?.trim().startsWith(`npm run ${script} `));

  // The two checks ci.yml gates on that verify was found to be missing.
  const GATES_MISSING_FROM_VERIFY = ['type-check:test', 'test:publish-cleanup'];

  it('finds both jobs it is meant to be comparing', () => {
    // The self-oracle every check in this file carries: matching nothing must
    // not read as everything passing.
    expect(stepsOf(CI_WORKFLOW, CI_JOB).length).toBeGreaterThan(0);
    expect(stepsOf(DOCKER_PUBLISH_WORKFLOW, VERIFY_JOB).length).toBeGreaterThan(0);
  });

  it.each(GATES_MISSING_FROM_VERIFY)('ci.yml runs npm run %s — sanity check on the check itself', script => {
    expect(
      hasRunStep(stepsOf(CI_WORKFLOW, CI_JOB), script),
      `expected ci.yml's ${CI_JOB} job to run npm run ${script}`,
    ).toBe(true);
  });

  it.each(GATES_MISSING_FROM_VERIFY)('docker-publish.yml verify job also runs npm run %s', script => {
    expect(
      hasRunStep(stepsOf(DOCKER_PUBLISH_WORKFLOW, VERIFY_JOB), script),
      `verify is missing npm run ${script}, which ci.yml gates on — an image can publish without it`,
    ).toBe(true);
  });
});

/**
 * Every `npm audit` step goes through scripts/npm-audit-retry.mjs. A bare
 * `npm audit` fails the workflow on a registry outage exactly as it does on a
 * real advisory — on 2026-09-04 the advisory endpoint flapped for most of a
 * day and three runs in a row of ci.yml went red at this step with every code
 * check green. The wrapper retries the endpoint error only; the advisory path
 * is pinned by server/npmAuditRetry.test.ts.
 */
describe('the audit steps retry a registry outage instead of failing the run', () => {
  const AUDIT_STEP_NAME = /^Security Audit/;
  const AUDIT_WRAPPER = 'npm-audit-retry.mjs';
  const BARE_NPM_AUDIT = /\bnpm audit\b/;

  const auditSteps = (): { file: string; job: string; step: WorkflowStep }[] =>
    workflowFiles().flatMap(file => {
      const workflow = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
      return Object.entries(workflow.jobs ?? {}).flatMap(([job, definition]) =>
        (definition.steps ?? [])
          .filter(step => !!step.name && AUDIT_STEP_NAME.test(step.name))
          .map(step => ({ file, job, step })),
      );
    });

  it('finds the audit steps it is meant to be checking', () => {
    // Both lockfiles, in both the push workflow and the scheduled one.
    expect(auditSteps().length).toBeGreaterThanOrEqual(4);
  });

  it('runs every audit step through the retry wrapper, never a bare npm audit', () => {
    const bare = auditSteps()
      .filter(({ step }) => !step.run?.includes(AUDIT_WRAPPER) || BARE_NPM_AUDIT.test(step.run ?? ''))
      .map(({ file, job, step }) => `${file} / ${job} / ${step.name}: ${step.run}`);

    expect(bare, 'a bare npm audit turns a registry outage into a failed run').toEqual([]);
  });

  it('points the server audit at the wrapper from inside server/', () => {
    // `working-directory: server` makes the script path relative to server/;
    // a root-relative path there is a file-not-found on the runner, which the
    // check above cannot tell from a working wrapper.
    const wrong = auditSteps()
      .filter(({ step }) => step['working-directory'] === 'server')
      .filter(({ step }) => !step.run?.includes(`../scripts/${AUDIT_WRAPPER}`))
      .map(({ file, job, step }) => `${file} / ${job}: ${step.run}`);

    expect(wrong).toEqual([]);
  });
});

/**
 * The e2e job runs one matrix leg per browser project, so the three engines
 * run in parallel on three runners instead of back to back on one (the suite
 * went from ~7 minutes serial to the slowest single engine). That moves WHICH
 * engines run out of playwright.config.ts, which the suite itself pins, into
 * the workflow's matrix, which nothing else does: dropping `webkit` from the
 * matrix would silently delete a third of the e2e coverage -- including the
 * only place WebKit's overscroll-behavior divergence is observed -- with every
 * check green. This ties the two lists together.
 */
describe('the e2e matrix runs exactly the browser projects playwright.config.ts defines', () => {
  const CI_WORKFLOW = 'ci.yml';
  const MATRIX_PROJECT = '${{ matrix.project }}';
  const PROJECT_FLAG = `--project=${MATRIX_PROJECT}`;
  const configuredProjects = (playwrightConfig.projects ?? []).map(project => project.name);

  const e2eJob = (): WorkflowJob | undefined =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, CI_WORKFLOW), 'utf8')).jobs?.e2e;

  it('finds the configured projects it is meant to be checking', () => {
    // The self-oracle: an empty config would make the matrix assertion vacuous.
    expect(configuredProjects.length).toBeGreaterThan(1);
  });

  /**
   * The matrix is include-only, and this test insists on it. GitHub does
   * not treat `include` entries as legs of their own when an original
   * `project:` list exists: an include that matches an original combination
   * is merged INTO it, and a later include may overwrite keys an earlier one
   * added. Two webkit shard entries next to `project: [.., webkit]` therefore
   * collapsed into a single "webkit 2/2" leg and half the suite ran nowhere,
   * with the workflow green (run 33870132833, 2026-09-04). With no original
   * matrix, every include entry is its own leg.
   */
  it('lists every configured project in the matrix, and nothing else', () => {
    const matrix = e2eJob()?.strategy?.matrix;
    expect(matrix?.project, 'an original project list swallows the shard includes').toBeUndefined();
    const legs = matrix?.include ?? [];
    expect([...new Set(legs.map(leg => leg.project))]).toEqual(configuredProjects);
  });

  it('lets the other browsers finish when one leg fails', () => {
    // A cancelled leg is a browser nobody tested; the failing one already
    // tells the story on its own.
    expect(e2eJob()?.strategy?.['fail-fast']).toBe(false);
  });

  /**
   * A project may be split across runners with Playwright's --shard: its
   * matrix entries carry shard_index and shard_total, one entry per shard.
   * What keeps a shard leg honest: every shard of the project is present (a
   * missing one is part of the suite running nowhere), no un-sharded entry
   * of the same project sits next to them (that leg would run the whole
   * suite again), the run step actually passes the shard, and the report
   * artifact name carries it, or the second leg's upload is refused as a
   * duplicate.
   */
  it('runs every shard leg as a real shard, and every shard of a sharded project', () => {
    const job = e2eJob();
    const legs = job?.strategy?.matrix?.include ?? [];
    const shards = legs.filter(leg => leg.shard_index !== undefined || leg.shard_total !== undefined);
    const steps = job?.steps ?? [];
    const run = steps.find(step => step.run?.includes('test:e2e'));
    const report = steps.find(step => step.uses?.startsWith('actions/upload-artifact'));

    for (const leg of shards) {
      expect(leg.shard_index, 'a shard leg needs shard_index').toEqual(expect.any(Number));
      expect(leg.shard_total, 'a shard leg needs shard_total').toEqual(expect.any(Number));
      expect(leg.shard_index).toBeGreaterThanOrEqual(1);
      expect(leg.shard_index).toBeLessThanOrEqual(leg.shard_total ?? 0);
    }
    if (shards.length > 0) {
      expect(run?.run, 'shard legs exist but the run step never passes --shard').toContain('--shard=');
      expect(run?.run).toContain('matrix.shard_index');
      expect(report?.with?.name, 'two shard legs would upload under one artifact name').toContain('matrix.shard_index');
    }
    const byProject = new Map<string, number[]>();
    for (const leg of shards) {
      byProject.set(leg.project ?? '', [...(byProject.get(leg.project ?? '') ?? []), leg.shard_index ?? 0]);
    }
    for (const [project, indexes] of byProject) {
      const total = shards.find(leg => leg.project === project)?.shard_total ?? 0;
      expect([...indexes].sort(), `${project} is missing a shard`).toEqual(
        Array.from({ length: total }, (_, i) => i + 1),
      );
      const unsharded = legs.filter(leg => leg.project === project && !shards.includes(leg));
      expect(unsharded, `${project} would run whole next to its shards`).toEqual([]);
    }
  });

  /**
   * The browser download is the same bytes on every run until the Playwright
   * version moves, and it cost every leg ~25 s. It is cached on the version
   * read from the lockfile and the leg's engine. Three ways a cache can be
   * worse than none, each pinned here: a key without the version serves a
   * stale browser to a bumped @playwright/test (which then downloads its own
   * on top, or fails); a key without the engine serves one leg's browser to
   * another; and a hit that skips the install step altogether skips the OS
   * libraries too, which live in /usr and are not in the cached directory,
   * so a hit must still run install-deps.
   */
  describe('caches the browser download', () => {
    const CACHE_HIT = "cache-hit == 'true'";
    const CACHE_MISS = "cache-hit != 'true'";
    const steps = (): WorkflowStep[] => e2eJob()?.steps ?? [];
    const cache = (): WorkflowStep | undefined => steps().find(step => step.uses?.startsWith('actions/cache@'));
    // Named rather than matched by `run` text: /playwright install\b/ and
    // .includes('playwright install') both also match "npx playwright
    // install-deps" (the \b boundary sits on the hyphen), which happened to
    // still resolve correctly only because that step comes later in the file.
    const install = (): WorkflowStep | undefined =>
      steps().find(step => step.name === 'Install Playwright browsers');
    const deps = (): WorkflowStep | undefined =>
      steps().find(step => step.run?.includes('playwright install-deps'));

    it('caches the Playwright browser directory', () => {
      expect(cache()?.with?.path).toContain('ms-playwright');
    });

    it('keys the cache on the Playwright version from the lockfile and the engine', () => {
      const key = String(cache()?.with?.key ?? '');
      expect(key).toContain(MATRIX_PROJECT);
      const versionStepId = /steps\.([\w-]+)\.outputs\.version/.exec(key)?.[1];
      expect(versionStepId, 'the key never reads a version output').toBeDefined();
      const versionStep = steps().find(step => step.id === versionStepId);
      expect(versionStep?.run, 'the version step must read it from the lockfile').toContain('package-lock.json');
      expect(versionStep?.run).toContain('@playwright/test');
    });

    it('downloads only on a miss, and installs the OS libraries on a hit', () => {
      const cacheId = cache()?.id;
      expect(cacheId).toBeDefined();
      expect(install()?.if).toBe(`steps.${cacheId}.outputs.${CACHE_MISS}`);
      expect(deps()?.if).toBe(`steps.${cacheId}.outputs.${CACHE_HIT}`);
      expect(deps()?.run).toContain(MATRIX_PROJECT);
    });
  });

  it('installs, runs and reports only its own browser on each leg', () => {
    const steps = e2eJob()?.steps ?? [];
    // Named rather than matched by `run` text: a substring match on
    // 'playwright install' also matches the later install-deps step's "npx
    // playwright install-deps ...".
    const install = steps.find(step => step.name === 'Install Playwright browsers');
    const run = steps.find(step => step.run?.includes('test:e2e'));
    const report = steps.find(step => step.uses?.startsWith('actions/upload-artifact'));

    expect(install?.run, 'downloading all three browsers on every leg wastes the split').toContain(MATRIX_PROJECT);
    expect(run?.run).toContain(PROJECT_FLAG);
    // upload-artifact refuses a second upload under a name another leg took.
    expect(report?.with?.name).toContain(MATRIX_PROJECT);
    expect(e2eJob()?.name, 'the check name must say which engine failed').toContain(MATRIX_PROJECT);
  });
});

/**
 * A called workflow can never hold more than the calling job grants. When a job
 * inside a reusable workflow asks for a scope its caller does not have, the run
 * does not merely lose that scope — GitHub refuses to parse the CALLER at all,
 * before a single step runs:
 *
 *   The nested job 'build' is requesting 'security-events: write', but is only
 *   allowed 'security-events: none'.
 *
 * docker-publish.yml's build job uploads a Trivy SARIF, so each of its three
 * callers has to grant security-events: write as well. Adding the scope to the
 * callee alone breaks every caller — and these publish workflows are
 * workflow_dispatch only, so nothing notices until someone tries to ship a
 * release and the Actions tab reports a broken workflow instead of running it.
 */
describe('every reusable-workflow call grants what the called workflow requests', () => {
  const LOCAL_CALL_PREFIX = './.github/workflows/';
  const NONE = 'none';
  const READ = 'read';
  const WRITE = 'write';
  const READ_ALL = 'read-all';
  const WRITE_ALL = 'write-all';
  const PERMISSION_RANK: Record<string, number> = { [NONE]: 0, [READ]: 1, [WRITE]: 2 };

  const rankOf = (level: string | undefined): number => PERMISSION_RANK[level ?? NONE] ?? 0;

  /**
   * The level a `permissions:` declaration grants for one scope.
   *
   * A map is exhaustive: every scope it omits is `none`, which is exactly how a
   * caller declaring only `contents: read` ends up denying the security-events
   * its callee needs. `undefined` means nothing was declared at all, and the
   * level then comes from a repository setting this test cannot see.
   */
  const grantedLevel = (permissions: Permissions | undefined, scope: string): string | undefined => {
    if (permissions === undefined) return undefined;
    if (permissions === READ_ALL) return READ;
    if (permissions === WRITE_ALL) return WRITE;
    if (typeof permissions === 'string') return undefined;
    return permissions[scope] ?? NONE;
  };

  /** Every job in this repository that calls a workflow from this repository. */
  const localCalls = (): { file: string; job: string; definition: WorkflowJob; caller: Workflow }[] =>
    workflowFiles().flatMap(file => {
      const workflow = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
      return Object.entries(workflow.jobs ?? {})
        .filter(([, definition]) => definition.uses?.startsWith(LOCAL_CALL_PREFIX))
        .map(([job, definition]) => ({ file, job, definition, caller: workflow }));
    });

  /**
   * Every scope the called workflow's jobs ask for, at the highest level any of
   * them asks for it. A job with no `permissions:` of its own inherits the
   * called workflow's workflow-level block, so that is what is read for it.
   */
  const requestedScopes = (called: Workflow): Map<string, string> => {
    const wanted = new Map<string, string>();
    for (const definition of Object.values(called.jobs ?? {})) {
      const declared = definition.permissions ?? called.permissions;
      // A shorthand string names no individual scope to compare; neither
      // workflow in this repository uses one, and the call below asserts that.
      if (declared === undefined || typeof declared === 'string') continue;
      for (const [scope, level] of Object.entries(declared)) {
        if (rankOf(level) > rankOf(wanted.get(scope))) wanted.set(scope, level);
      }
    }
    return wanted;
  };

  it('reads a permissions map as denying every scope it omits', () => {
    expect(grantedLevel({ contents: READ }, 'security-events')).toBe(NONE);
    expect(grantedLevel({ contents: READ, 'security-events': WRITE }, 'security-events')).toBe(WRITE);
    expect(grantedLevel(READ_ALL, 'security-events')).toBe(READ);
    expect(grantedLevel(WRITE_ALL, 'security-events')).toBe(WRITE);
    expect(grantedLevel(undefined, 'contents')).toBeUndefined();
  });

  it('finds the reusable-workflow calls it is meant to be checking', () => {
    const callers = localCalls().map(call => call.file);
    // All three publish workflows call docker-publish.yml; a rename that left
    // this list matching nothing would make the check below vacuously green.
    expect(callers).toEqual(
      expect.arrayContaining(['publish-latest.yml', 'publish-nightly.yml', 'publish-tag.yml']),
    );
  });

  it('grants every scope the called workflow requests, at no lower a level', () => {
    for (const call of localCalls()) {
      const calledFile = (call.definition.uses ?? '').slice(LOCAL_CALL_PREFIX.length);
      const called = parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, calledFile), 'utf8'));
      const scopes = [...requestedScopes(called)];
      expect(scopes.length, `${calledFile} declares no permissions to compare against`).toBeGreaterThan(0);

      for (const [scope, level] of scopes) {
        const granted = grantedLevel(call.definition.permissions ?? call.caller.permissions, scope);
        expect(
          granted,
          `${call.file} job '${call.job}' declares no permissions, so what ${calledFile} may hold is a repository setting`,
        ).toBeDefined();
        expect(
          rankOf(granted),
          `${call.file} job '${call.job}' grants ${scope}: ${granted}, but ${calledFile} requests ${scope}: ${level} — GitHub will refuse to run ${call.file} at all`,
        ).toBeGreaterThanOrEqual(rankOf(level));
      }
    }
  });
});

/**
 * docker-publish.yml's build job scans the smoke-tested image with Trivy and
 * uploads the SARIF. Two inputs decide whether what reaches the Security tab
 * is what the step says it is:
 *
 * - `severity:` alone does NOT narrow a SARIF upload. trivy-action writes every
 *   severity to SARIF unless `limit-severities-for-sarif` is set as well; the
 *   first upload (2026-09-07) put 23 LOW/MEDIUM alerts beside the 6 HIGH the
 *   step claimed to be limited to.
 * - The Dockerfile's `apk upgrade` runs in a layer the GHA cache keeps until
 *   an instruction above it or the base digest changes, so a scan of a cached
 *   runtime stage grades packages that were current at some earlier publish.
 *   `no-cache-filters: runtime` on the build that is smoke tested and scanned
 *   rebuilds that stage every time. The push step must NOT carry it: it reads
 *   the cache the first build just wrote, and that is what keeps the pushed
 *   image identical to the scanned one.
 */
describe('docker-publish.yml scans the image it pushes, at the severities it names', () => {
  const DOCKER_PUBLISH_WORKFLOW = 'docker-publish.yml';
  const BUILD_JOB = 'build';
  const TRIVY_ACTION = 'aquasecurity/trivy-action';
  const BUILD_PUSH_ACTION = 'docker/build-push-action';
  const SEVERITY_INPUT = 'severity';
  const LIMIT_SEVERITIES_INPUT = 'limit-severities-for-sarif';
  const NO_CACHE_FILTERS_INPUT = 'no-cache-filters';
  const CACHE_TO_INPUT = 'cache-to';
  const CACHE_FROM_INPUT = 'cache-from';
  const PUSH_INPUT = 'push';
  const RUNTIME_STAGE = 'runtime';
  const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');
  // YAML hands the action a boolean; Actions coerces it to the string it reads.
  const ENABLED = [true, 'true'];

  const buildSteps = (): WorkflowStep[] =>
    parseWorkflow(fs.readFileSync(path.join(WORKFLOWS_DIR, DOCKER_PUBLISH_WORKFLOW), 'utf8')).jobs?.[BUILD_JOB]
      ?.steps ?? [];
  const usesAction = (step: WorkflowStep, action: string): boolean => step.uses?.startsWith(`${action}@`) === true;

  const scanStep = (): WorkflowStep | undefined => buildSteps().find(step => usesAction(step, TRIVY_ACTION));
  const imageBuilds = (): WorkflowStep[] => buildSteps().filter(step => usesAction(step, BUILD_PUSH_ACTION));
  /** The build that is loaded into the daemon, smoke tested and scanned: the one that writes the cache. */
  const smokeBuildOf = (builds: WorkflowStep[]): WorkflowStep | undefined =>
    builds.find(step => step.with?.[CACHE_TO_INPUT] !== undefined);
  /** The build that publishes: reads the cache, writes nothing. */
  const pushBuildOf = (builds: WorkflowStep[]): WorkflowStep | undefined =>
    builds.find(step => step.with?.[PUSH_INPUT] === true);

  /** The stages a step's `no-cache-filters` names (the action takes a comma-separated list). */
  const uncachedStagesOf = (step: WorkflowStep | undefined): string[] =>
    String(step?.with?.[NO_CACHE_FILTERS_INPUT] ?? '')
      .split(',')
      .map(stage => stage.trim())
      .filter(stage => stage.length > 0);

  it('finds the scan step and both image builds it is meant to be checking', () => {
    // The self-oracle: matching nothing must not read as everything passing.
    expect(scanStep()).toBeDefined();
    const builds = imageBuilds();
    expect(smokeBuildOf(builds)).toBeDefined();
    expect(pushBuildOf(builds)).toBeDefined();
    expect(smokeBuildOf(builds)).not.toBe(pushBuildOf(builds));
  });

  it('limits the SARIF upload to the severities the scan step names', () => {
    const scan = scanStep();
    expect(scan?.with?.[SEVERITY_INPUT], 'the scan names no severities, so there is nothing to limit to').toBeDefined();
    expect(ENABLED).toContain(scan?.with?.[LIMIT_SEVERITIES_INPUT]);
  });

  it('rebuilds the runtime stage uncached on the build that is smoke tested and scanned', () => {
    expect(uncachedStagesOf(smokeBuildOf(imageBuilds()))).toContain(RUNTIME_STAGE);
  });

  it('lets the push reuse exactly the build that was scanned', () => {
    const builds = imageBuilds();
    const push = pushBuildOf(builds);
    expect(push?.with?.[NO_CACHE_FILTERS_INPUT]).toBeUndefined();
    expect(push?.with?.[CACHE_FROM_INPUT]).toBeDefined();
    expect(push?.with?.[CACHE_FROM_INPUT]).toBe(smokeBuildOf(builds)?.with?.[CACHE_FROM_INPUT]);
  });

  it('names only stages the Dockerfile actually has', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    for (const stage of uncachedStagesOf(smokeBuildOf(imageBuilds()))) {
      expect(dockerfile, `no \`AS ${stage}\` stage in the Dockerfile`).toMatch(
        new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage}\\s*$`, 'mi'),
      );
    }
  });
});
