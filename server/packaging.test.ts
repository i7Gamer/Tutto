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
// production import graph — socketTestHarness spawns child processes, and
// neither is copied into the image.
const TEST_ONLY_HELPERS = ['socketTestHarness.ts', 'testPorts.ts'];

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

describe('files the Docker image must copy', () => {
  const isCoveredByImage = (repoRelativePath: string): boolean =>
    IMAGE_EXTERNAL_PATHS.some(
      allowed => repoRelativePath === allowed || repoRelativePath.startsWith(`${allowed}/`)
    );

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
    const dockerignore = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
    const entries = dockerignore
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
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
});
