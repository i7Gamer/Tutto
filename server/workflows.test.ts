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

interface WorkflowJob {
  name?: string;
  steps?: WorkflowStep[];
  strategy?: WorkflowStrategy;
  'timeout-minutes'?: number;
}

interface WorkflowConcurrency {
  group?: string;
  'cancel-in-progress'?: boolean;
}

interface Workflow {
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

  it('lists every configured project in the matrix, and nothing else', () => {
    expect(e2eJob()?.strategy?.matrix?.project).toEqual(configuredProjects);
  });

  it('lets the other browsers finish when one leg fails', () => {
    // A cancelled leg is a browser nobody tested; the failing one already
    // tells the story on its own.
    expect(e2eJob()?.strategy?.['fail-fast']).toBe(false);
  });

  /**
   * A project may be split across runners with Playwright's --shard. The
   * split is declared as matrix `include` entries carrying shard_index and
   * shard_total, which GitHub turns into extra legs of that project. Two
   * things keep a shard leg honest: the run step must actually pass the
   * shard (an include without it would run the whole project twice and
   * report both as separate legs), and the report artifact name must carry
   * the shard, or the second leg's upload is refused as a duplicate.
   */
  it('runs every shard leg as a real shard of a configured project', () => {
    const job = e2eJob();
    const includes = job?.strategy?.matrix?.include ?? [];
    const steps = job?.steps ?? [];
    const run = steps.find(step => step.run?.includes('test:e2e'));
    const report = steps.find(step => step.uses?.startsWith('actions/upload-artifact'));

    for (const leg of includes) {
      expect(configuredProjects, `shard leg for an unknown project: ${leg.project}`).toContain(leg.project);
      expect(leg.shard_index, 'a shard leg needs shard_index').toEqual(expect.any(Number));
      expect(leg.shard_total, 'a shard leg needs shard_total').toEqual(expect.any(Number));
      expect(leg.shard_index).toBeGreaterThanOrEqual(1);
      expect(leg.shard_index).toBeLessThanOrEqual(leg.shard_total ?? 0);
    }
    if (includes.length > 0) {
      expect(run?.run, 'shard legs exist but the run step never passes --shard').toContain('--shard=');
      expect(run?.run).toContain('matrix.shard_index');
      expect(report?.with?.name, 'two shard legs would upload under one artifact name').toContain('matrix.shard_index');
    }
    // Every shard of a project must be present, or part of that project's
    // suite never runs anywhere.
    const byProject = new Map<string, number[]>();
    for (const leg of includes) {
      byProject.set(leg.project ?? '', [...(byProject.get(leg.project ?? '') ?? []), leg.shard_index ?? 0]);
    }
    for (const [project, indexes] of byProject) {
      const total = includes.find(leg => leg.project === project)?.shard_total ?? 0;
      expect([...indexes].sort(), `${project} is missing a shard`).toEqual(
        Array.from({ length: total }, (_, i) => i + 1),
      );
    }
  });

  it('installs, runs and reports only its own browser on each leg', () => {
    const steps = e2eJob()?.steps ?? [];
    const install = steps.find(step => step.run?.includes('playwright install'));
    const run = steps.find(step => step.run?.includes('test:e2e'));
    const report = steps.find(step => step.uses?.startsWith('actions/upload-artifact'));

    expect(install?.run, 'downloading all three browsers on every leg wastes the split').toContain(MATRIX_PROJECT);
    expect(run?.run).toContain(PROJECT_FLAG);
    // upload-artifact refuses a second upload under a name another leg took.
    expect(report?.with?.name).toContain(MATRIX_PROJECT);
    expect(e2eJob()?.name, 'the check name must say which engine failed').toContain(MATRIX_PROJECT);
  });
});
