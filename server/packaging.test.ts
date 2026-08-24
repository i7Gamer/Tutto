/** @vitest-environment node */
/**
 * Guards the production server's *packaging* contract rather than its
 * behaviour: what the server may import, and which files therefore have to
 * exist inside the Docker image.
 *
 * These are the failure modes ordinary unit tests cannot see, because a local
 * `npm install` hides both of them:
 *
 *  - npm hoists the root package.json's dependencies into the top-level
 *    node_modules, so `import { v4 } from 'uuid'` resolves in dev even though
 *    uuid was never declared in server/package.json. The image installs the
 *    server workspace on its own (`npm ci --omit=dev` in server/), where the
 *    hoisted copy does not exist and the container dies at startup.
 *  - the server imports shared game logic from src/ and playerColors.json from
 *    the repo root, so the image needs more than server/. A new cross-boundary
 *    import is invisible locally and only surfaces as a crash on `docker run`.
 *
 * Both classes of bug shipped as far as a built image before being caught by
 * hand. If one of these tests fails, fix the import *or* update the
 * corresponding COPY lines in the Dockerfile — the two must stay in sync.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';

const SERVER_DIR = __dirname;
const REPO_ROOT = path.join(__dirname, '..');

// Helpers that exist only for the test suites. They must never appear in the
// production import graph — socketTestHarness spawns child processes, and none
// of them is copied into the image.
//
// Kept honest by "lists every genuinely test-only helper" below, which derives
// the same fact from the imports: every other assertion here reads from THIS
// list, so before that check a helper missing from it was invisible.
const TEST_ONLY_HELPERS = ['socketTestHarness.ts', 'testPorts.ts', 'testTimeouts.ts'];

// Repo-relative paths (file or directory) outside server/ that the production
// image copies. Must mirror the COPY lines in the Dockerfile.
const IMAGE_EXTERNAL_PATHS = ['src/types.ts', 'src/utils', 'playerColors.json'];

// Extensions the TypeScript/Node resolver will try for an extensionless
// relative specifier such as '../src/utils/coreGameEngine'.
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.json'];

// Files whose contents are scanned for further imports. A .json leaf is part
// of the graph but has nothing to follow.
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js'];

// Matches `from '<spec>'`, `require('<spec>')` and `import('<spec>')`. A
// multi-line `import { a, b } from 'x'` still terminates in `from 'x'`, so a
// line-oriented scan is not needed.
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/g;

const toRepoRelative = (absolute: string): string =>
  path.relative(REPO_ROOT, absolute).split(path.sep).join('/');

const isTestFile = (fileName: string): boolean => fileName.endsWith('.test.ts');

const readImportSpecifiers = (file: string): string[] => {
  if (!CODE_EXTENSIONS.includes(path.extname(file))) return [];
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_SPECIFIER)].map(match => match[1] as string);
};

const isExistingFile = (candidate: string): boolean =>
  fs.existsSync(candidate) && fs.statSync(candidate).isFile();

const resolveRelativeImport = (fromFile: string, specifier: string): string | null => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (isExistingFile(base)) return base;
  for (const extension of RESOLVABLE_EXTENSIONS) {
    if (isExistingFile(base + extension)) return base + extension;
  }
  for (const extension of RESOLVABLE_EXTENSIONS) {
    const indexFile = path.join(base, `index${extension}`);
    if (isExistingFile(indexFile)) return indexFile;
  }
  return null;
};

// 'socket.io' -> 'socket.io', 'socket.io/client' -> 'socket.io',
// '@types/express' -> '@types/express'.
const packageNameOf = (specifier: string): string => {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] as string);
};

const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || builtinModules.includes(packageNameOf(specifier));

interface ImportGraph {
  /** Every file reachable from the production entry points, including them. */
  files: string[];
  /** Bare package specifier -> repo-relative path of the first file importing it. */
  packages: Map<string, string>;
  /** Relative imports that resolved to nothing on disk. */
  unresolved: string[];
}

/**
 * Walks the production import graph from every non-test file in server/,
 * following relative imports across the src/ boundary.
 *
 * Type-only imports are deliberately treated as real edges. They are erased at
 * runtime, so this over-approximates what the image strictly needs — the safe
 * direction: it can only ask for a file to be copied that turns out to be
 * unnecessary, never miss one that is.
 */
const buildProductionImportGraph = (): ImportGraph => {
  const entryFiles = fs
    .readdirSync(SERVER_DIR)
    .filter(name => name.endsWith('.ts'))
    .filter(name => !isTestFile(name))
    .filter(name => !TEST_ONLY_HELPERS.includes(name))
    .map(name => path.join(SERVER_DIR, name));

  const visited = new Set<string>();
  const packages = new Map<string, string>();
  const unresolved: string[] = [];
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of readImportSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(file, specifier);
        if (resolved === null) {
          unresolved.push(`${toRepoRelative(file)} -> ${specifier}`);
          continue;
        }
        queue.push(resolved);
        continue;
      }
      const packageName = packageNameOf(specifier);
      if (isNodeBuiltin(specifier)) continue;
      if (!packages.has(packageName)) packages.set(packageName, toRepoRelative(file));
    }
  }

  return { files: [...visited], packages, unresolved };
};

interface CopyInstruction {
  sources: string[];
  destination: string;
}

/**
 * Every COPY instruction in the Dockerfile. A COPY line is
 * `COPY [--flags] <src>... <dest>`, so the flags are dropped and the final
 * token is the destination.
 */
const readDockerfileCopyInstructions = (): CopyInstruction[] => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
  return dockerfile
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.toUpperCase().startsWith('COPY '))
    .map(line => {
      const tokens = line
        .slice('COPY '.length)
        .split(/\s+/)
        .filter(token => token.length > 0 && !token.startsWith('--'));
      return {
        sources: tokens.slice(0, -1),
        destination: tokens[tokens.length - 1] as string,
      };
    });
};

const readDockerfileCopySources = (): string[] =>
  readDockerfileCopyInstructions().flatMap(instruction => instruction.sources);

const readDockerfile = (): string => fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');

/**
 * The container's entrypoint, as the argv array of the exec-form `CMD`.
 *
 * Only the exec form is considered: HEALTHCHECK carries its own shell-form
 * `CMD`, and matching that instead would silently test the wrong line.
 */
const readDockerfileCmd = (): string[] => {
  const execForm = readDockerfile()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.toUpperCase().startsWith('CMD ['))
    .map(line => line.slice('CMD '.length));

  expect(execForm).toHaveLength(1);
  return JSON.parse(execForm[0] as string) as string[];
};

// Node resolves a bare specifier by walking node_modules directories upward
// from the *importing* file, so only a copy at the image's working directory
// is reachable from both /app/server and /app/src.
const RESOLVABLE_NODE_MODULES_DESTINATIONS = ['./node_modules', '/app/node_modules'];

const graph = buildProductionImportGraph();

interface ServerManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const readServerManifest = (): ServerManifest => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')
  ) as Partial<ServerManifest>;
  return {
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
  };
};

describe('production import graph', () => {
  it('resolves every relative import to a file on disk', () => {
    expect(graph.unresolved).toEqual([]);
  });

  it('reaches at least the known production entry points', () => {
    // Sanity check on the walker itself: an over-eager filter that matched
    // nothing would make every other assertion here vacuously pass.
    const reached = graph.files.map(toRepoRelative);
    expect(reached).toContain('server/index.ts');
    expect(reached).toContain('server/socketHandlers.ts');
    expect(reached).toContain('src/utils/coreGameEngine.ts');
  });

  it('never pulls a test-only helper into production code', () => {
    const leaked = graph.files
      .map(file => path.basename(file))
      .filter(name => TEST_ONLY_HELPERS.includes(name));
    expect(leaked).toEqual([]);
  });

  it('lists every genuinely test-only helper in TEST_ONLY_HELPERS', () => {
    // The oracle the other two assertions lack. Both the leak check above and
    // the .dockerignore check below derive from TEST_ONLY_HELPERS, so a helper
    // MISSING from that list is invisible to both — which is how
    // testTimeouts.ts came to be shipped by `COPY server/*.ts` and enrolled as
    // a production graph root. This derives the same fact from the imports
    // instead: a non-test server file whose importers are all test files (or
    // themselves test-only) is test-only, whatever the list happens to say.
    const serverFiles = fs
      .readdirSync(SERVER_DIR)
      .filter(name => name.endsWith('.ts'));

    const importsOf = new Map<string, Set<string>>();
    for (const name of serverFiles) {
      const specifiers = readImportSpecifiers(path.join(SERVER_DIR, name))
        .filter(specifier => specifier.startsWith('.'));
      for (const specifier of specifiers) {
        const resolved = resolveRelativeImport(path.join(SERVER_DIR, name), specifier);
        if (resolved === null || path.dirname(resolved) !== SERVER_DIR) continue;
        const target = path.basename(resolved);
        if (!importsOf.has(target)) importsOf.set(target, new Set());
        (importsOf.get(target) as Set<string>).add(name);
      }
    }

    // Fixed point, so a helper imported only by another test-only helper is
    // still recognised as test-only.
    const testOnly = new Set(serverFiles.filter(isTestFile));
    let grew = true;
    while (grew) {
      grew = false;
      for (const name of serverFiles) {
        if (testOnly.has(name)) continue;
        const importers = importsOf.get(name);
        // No importer at all = an entry point (index.ts), not a helper.
        if (!importers || importers.size === 0) continue;
        if ([...importers].every(importer => testOnly.has(importer))) {
          testOnly.add(name);
          grew = true;
        }
      }
    }

    const undeclared = [...testOnly]
      .filter(name => !isTestFile(name))
      .filter(name => !TEST_ONLY_HELPERS.includes(name))
      .sort();

    expect(
      undeclared,
      `Imported only by tests, but absent from TEST_ONLY_HELPERS (so it ships in the image and roots the production graph): ${undeclared.join(', ')}`,
    ).toEqual([]);
  });
});

describe('server/package.json declares what the server imports', () => {
  it('declares every third-party package reachable from production code', () => {
    const { dependencies } = readServerManifest();
    const undeclared = [...graph.packages.entries()]
      .filter(([packageName]) => !(packageName in dependencies))
      .map(([packageName, importer]) => `${packageName} (imported by ${importer})`)
      .sort();

    // Anything listed here resolves in dev only through npm's hoisting of the
    // ROOT package.json, and is missing from `npm ci --omit=dev` in server/.
    expect(undeclared).toEqual([]);
  });

  it('does not reach a package that is only a devDependency', () => {
    const { dependencies, devDependencies } = readServerManifest();
    // Distinct from the check above: a package declared in the server manifest
    // but only under devDependencies resolves fine locally and disappears in
    // the image, which installs with --omit=dev.
    const devOnly = [...graph.packages.entries()]
      .filter(([packageName]) => !(packageName in dependencies) && packageName in devDependencies)
      .map(([packageName, importer]) => `${packageName} (imported by ${importer})`)
      .sort();

    expect(devOnly).toEqual([]);
  });
});

/**
 * Whether a COPY source covers a repo-relative path.
 *
 * `*` matches within one path segment and nothing across it, exactly as
 * Docker's own glob does — which is the entire point of the check below.
 * A source with no wildcard is a file or a whole directory.
 */
const matchesCopySource = (source: string, file: string): boolean => {
  if (!source.includes('*')) return file === source || file.startsWith(`${source}/`);
  const pattern = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`).test(file);
};

/** The .dockerignore's active pattern lines, comments and blanks stripped. */
const dockerignoreEntries = (): string[] =>
  fs
    .readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

// Never walked when expanding a pattern: node_modules and dist would add tens
// of thousands of paths to every glob for nothing (both are ignored wholesale),
// .git is not part of the build context, and scratch/ is gitignored local junk
// a contributor may or may not have.
const UNSCANNED_DIRS = ['node_modules', 'dist', '.git', 'scratch'];

/** Repo-relative matches for a glob, with separators normalised to '/'. */
const globRepo = (patterns: string | string[]): string[] =>
  fs
    .globSync(patterns, {
      cwd: REPO_ROOT,
      exclude: (entry: string) => UNSCANNED_DIRS.includes(entry.split(/[\\/]/)[0] as string),
    })
    .map(match => match.split(path.sep).join('/'));

describe('files the Docker image must copy', () => {
  const isCoveredByImage = (repoRelativePath: string): boolean =>
    IMAGE_EXTERNAL_PATHS.some(
      allowed => repoRelativePath === allowed || repoRelativePath.startsWith(`${allowed}/`)
    );

  it('copies every production file inside server/, subdirectories included', () => {
    // The server is copied by `COPY server/*.ts`, and that glob is SHALLOW:
    // a module moved into server/anything/ is silently left out of the image
    // and the container dies at startup with "Cannot find module". The
    // cross-boundary check below would not notice — the file is still inside
    // server/ — so nothing else in this suite covers it.
    const sources = readDockerfileCopySources();
    const uncopied = graph.files
      .map(toRepoRelative)
      .filter(file => file.startsWith('server/'))
      .filter(file => !sources.some(source => matchesCopySource(source, file)))
      .sort();

    expect(uncopied).toEqual([]);
  });

  it('imports nothing outside server/ that the image does not copy', () => {
    const uncopied = graph.files
      .map(toRepoRelative)
      .filter(file => !file.startsWith('server/'))
      .filter(file => !isCoveredByImage(file))
      .sort();

    // A new cross-boundary import needs a matching COPY line in the Dockerfile
    // and an entry in IMAGE_EXTERNAL_PATHS above, or the container will crash
    // at startup with "Cannot find module".
    expect(uncopied).toEqual([]);
  });

  it('has a Dockerfile COPY line for every path in the list', () => {
    // Closes the loop. Without this, updating IMAGE_EXTERNAL_PATHS above and
    // forgetting the matching COPY line would leave every test green and the
    // container still crashing at startup.
    const copied = readDockerfileCopySources();
    const missing = IMAGE_EXTERNAL_PATHS.filter(required => !copied.includes(required));
    expect(missing).toEqual([]);
  });

  it('keeps test-only helpers out of the build context', () => {
    // The .dockerignore is what stops them being copied by `COPY server/*.ts`.
    const entries = dockerignoreEntries();
    const unignored = TEST_ONLY_HELPERS.filter(helper => !entries.includes(`server/${helper}`));
    expect(unignored).toEqual([]);
  });

  it('installs node_modules where the shared code outside server/ can resolve it', () => {
    const externalFiles = graph.files.map(toRepoRelative).filter(file => !file.startsWith('server/'));
    // Only meaningful while the server imports across the boundary at all.
    expect(externalFiles.length).toBeGreaterThan(0);

    const install = readDockerfileCopyInstructions().find(instruction =>
      instruction.sources.some(source => source.endsWith('node_modules'))
    );

    // Installed under ./server, a bare import added to src/utils resolves
    // locally (npm hoists to the repo root) and dies in the container with
    // "Cannot find module" — the same class of bug the checks above exist for,
    // and one no dependency declaration can catch.
    expect(install).toBeDefined();
    expect(RESOLVABLE_NODE_MODULES_DESTINATIONS).toContain(install?.destination);
  });

  it('still needs every path the image copies', () => {
    const externalFiles = graph.files.map(toRepoRelative).filter(file => !file.startsWith('server/'));
    const unused = IMAGE_EXTERNAL_PATHS.filter(
      allowed => !externalFiles.some(file => file === allowed || file.startsWith(`${allowed}/`))
    );

    // Keeps the Dockerfile from accumulating COPY lines for shared code the
    // server has stopped using.
    expect(unused).toEqual([]);
  });
});

/**
 * The .dockerignore as a whole, rather than only the test-only-helper lines the
 * check above derives from TEST_ONLY_HELPERS.
 *
 * A pattern here fails silently in both directions: one that matches nothing
 * still reads like protection, and a file the patterns never learned about is
 * copied without a word. Neither shows up in a build log.
 */
describe('.dockerignore keeps the build context clean', () => {
  // `?` and `[]` included: Docker's matcher is Go's filepath.Match plus `**`,
  // and all of them mean an entry names a set rather than one concrete path.
  const GLOB_METACHARACTERS = /[*?[\]]/;

  // Test files are named for one of these, everywhere in the repository.
  const TEST_FILE_PATTERNS = ['**/*.test.*', '**/*.spec.*'];

  // Entries that deliberately match nothing in a clean checkout. The Token
  // Savior index is a machine-local cache and is never committed.
  const OPTIONALLY_ABSENT_ENTRIES = ['.token-savior-cache.json'];

  /**
   * Whether the .dockerignore keeps a repo-relative path out of the context.
   *
   * Expanded against the real filesystem rather than reimplementing Docker's
   * matcher. Node's glob is a different engine, but it agrees with Docker's on
   * every construct this file uses — and the one construct where they DIVERGE,
   * brace alternation, is rejected outright by the syntax test below, so this
   * only ever expands patterns both engines read the same way.
   */
  const isIgnored = (() => {
    const exact = new Set<string>();
    const directories: string[] = [];
    for (const entry of dockerignoreEntries()) {
      for (const match of globRepo(entry)) {
        exact.add(match);
        if (fs.statSync(path.join(REPO_ROOT, match)).isDirectory()) directories.push(`${match}/`);
      }
    }
    return (file: string): boolean =>
      exact.has(file) || directories.some(directory => file.startsWith(directory));
  })();

  it('uses only pattern syntax Docker implements', () => {
    // Brace alternation is NOT in Docker's grammar: `*.test.{js,ts}` matches a
    // file literally named "*.test.{js,ts}" and nothing else, so a pattern
    // written that way silently protects nothing while looking thorough — and
    // Node's glob DOES expand braces, so isIgnored above would report the
    // coverage Docker never delivers. `!` negation Docker does implement, but
    // isIgnored does not model it, which would over-report just as quietly.
    const unsupported = dockerignoreEntries().filter(
      entry => /[{}]/.test(entry) || entry.startsWith('!'),
    );
    expect(unsupported).toEqual([]);
  });

  it('names no concrete file that has since moved or been deleted', () => {
    // How playwright.config.js outlived the rename to .ts: the entry stayed,
    // stopped matching anything, and nothing anywhere said so. Only entries
    // naming a file (an extension, no wildcard) are checked — the extensionless
    // ones are directories a clean checkout legitimately may not have.
    const stale = dockerignoreEntries()
      .filter(entry => !GLOB_METACHARACTERS.test(entry))
      .filter(entry => path.extname(entry) !== '')
      .filter(entry => !OPTIONALLY_ABSENT_ENTRIES.includes(entry))
      .filter(entry => !fs.existsSync(path.join(REPO_ROOT, entry)))
      .sort();

    expect(stale).toEqual([]);
  });

  it('excludes every test file in the repository', () => {
    const testFiles = globRepo(TEST_FILE_PATTERNS);

    // Without this the assertion below would pass by scanning nothing at all.
    expect(testFiles.length).toBeGreaterThan(0);

    // src/sw.test.js and vite.config.test.ts both walked past patterns that
    // only named .ts/.tsx under src/. The build context is not the image —
    // stage 1 exports dist/ and nothing else — but this file is the only thing
    // standing between a test file and `COPY . .`, and the entry it should
    // have matched is the same entry the image's own protection leans on.
    expect(testFiles.filter(file => !isIgnored(file)).sort()).toEqual([]);
  });
});

/**
 * The image copies server/package.json ("type": "commonjs") but no root
 * manifest, so /app/src/** is CommonJS in the container while the repo root's
 * "type": "module" makes it ESM in dev. tsx handles both, but `import.meta` has
 * no CommonJS equivalent — a shared file that used it would pass every test and
 * every build here, then crash only on `docker run`.
 */
describe('shared code the image runs under a different module type', () => {
  const sharedSources = graph.files
    .map(toRepoRelative)
    .filter(file => !file.startsWith('server/'))
    .filter(file => CODE_EXTENSIONS.includes(path.extname(file)));

  it('has shared sources to check', () => {
    expect(sharedSources.length).toBeGreaterThan(0);
  });

  it('uses no ESM-only syntax outside server/', () => {
    const esmOnly = sharedSources.filter(file =>
      /\bimport\s*\.\s*meta\b/.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    );

    expect(esmOnly).toEqual([]);
  });
});

/**
 * server/shutdown.ts only runs if the process Docker signals is the server.
 *
 * `CMD ["tsx", …]` does not do that: the tsx CLI spawns the script as a child
 * and relays signals to it over an IPC socket, giving the child 30ms to
 * acknowledge before it is SIGKILLed. A container stopped while the event loop
 * is busy therefore loses exactly the ordered shutdown that handler exists for.
 */
describe('the image runs the server as PID 1', () => {
  it('makes node itself the entrypoint rather than a launcher that forks', () => {
    expect(readDockerfileCmd()[0]).toBe('node');
  });

  it('loads TypeScript through tsx as an import hook', () => {
    const cmd = readDockerfileCmd();
    const flag = cmd.indexOf('--import');
    expect(flag).toBeGreaterThan(-1);
    expect(cmd[flag + 1]).toBe('tsx');
  });

  it('installs tsx where node resolves it from the working directory', () => {
    // `--import tsx` is a bare specifier: node walks node_modules upward from
    // WORKDIR and never looks in npm's global prefix. A global install would
    // resolve for the `tsx` binary and fail for the import hook.
    expect(readDockerfile()).not.toMatch(/npm\s+install\s+-g\s+tsx/);
  });

  // The Dockerfile was the only launcher this described. `start:prod` is the
  // production-from-source route the README documents, and it kept the exact
  // form the image was moved away from — including on Windows, where libuv
  // maps the relayed kill to TerminateProcess with no grace at all, and where
  // this project's own production instance runs from a .bat calling it.
  it('starts the same way from source as it does in the image', () => {
    const startProd = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ).scripts['start:prod'];

    // The token before `tsx` is what separates the two launchers: as an
    // --import hook the server stays the process it started as, and as a bare
    // command the tsx CLI forks it and relays signals over IPC.
    const launcher = /(\S+)\s+tsx\s+server\/index\.ts/.exec(startProd);
    expect(launcher, `no server launch found in start:prod: ${startProd}`).not.toBeNull();
    expect(launcher![1], 'the tsx CLI forks the server and relays signals to it')
      .toBe('--import');
    expect(startProd).toContain('node --import tsx server/index.ts');
  });
});
