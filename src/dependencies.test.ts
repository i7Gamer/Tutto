/**
 * Every runtime dependency in the ROOT package.json must be imported by
 * something that ships: a module under src/ (the client bundle and the
 * service worker) or under server/ (which shares src/utils at runtime).
 *
 * A dependency nobody imports is still audited, Dependabot-bumped and
 * installed on every CI run and in every Docker build, for nothing — round 6
 * found two such packages (clsx and tailwind-merge) that had outlived the
 * component that once used them. server/packaging.test.ts guards the server
 * manifest the other way round (declares what it imports); this is the root
 * manifest's counterpart, so an "unused dependency" is a failing test rather
 * than a review finding.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['src', 'server'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.claude']);

// Packages that ship without a literal import in the source tree, each with
// the mechanism that pulls them in. Keep this list short and every entry
// justified — it is the one place an unused dependency can hide.
const IMPORTED_BY_TOOLING: Record<string, string> = {
  // zustand/middleware/immer (src/store) imports immer itself; zustand lists
  // it as an optional peer, so the app must declare it or the middleware
  // resolves nothing at runtime.
  immer: 'peer dependency of zustand/middleware/immer',
};

const isTestFile = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || file.split(/[\\/]/).includes('testing');

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(full)) out.push(full);
  }
  return out;
};

// `from 'pkg'`, `from 'pkg/sub'`, `import('pkg')`, `require('pkg')` — the
// package name is the first segment (two for a scoped package).
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*)['"]([^'".][^'"]*)['"]/g;
const packageOf = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};

const importedPackages = (): Set<string> => {
  const seen = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT_SPECIFIER)) seen.add(packageOf(match[1]));
    }
  }
  return seen;
};

describe('root package.json dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  it('are each imported by shipping code (or justified in IMPORTED_BY_TOOLING)', () => {
    const imported = importedPackages();
    const unused = Object.keys(manifest.dependencies)
      .filter(name => !imported.has(name) && !(name in IMPORTED_BY_TOOLING));
    expect(unused, 'remove these from dependencies, or justify them').toEqual([]);
  });

  it('lists every IMPORTED_BY_TOOLING entry as a real dependency', () => {
    const stale = Object.keys(IMPORTED_BY_TOOLING).filter(name => !(name in manifest.dependencies));
    expect(stale).toEqual([]);
  });
});
