import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { defineConfig, globalIgnores } from 'eslint/config'
import noConflictingClassnames from './eslint-rules/no-conflicting-classnames.js'

// Repo-local rules. See each rule's own file for the bug it was written against.
const local = { rules: { 'no-conflicting-classnames': noConflictingClassnames } }

const sharedRules = {
  'no-empty': ['error', { allowEmptyCatch: true }],
}

const sharedTsRules = {
  ...sharedRules,
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
}

const sharedJsRules = {
  ...sharedRules,
  'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
}

export default defineConfig([
  globalIgnores([
    'dist',
    'coverage',
    'test-results',
    'playwright-report',
    'scratch',
    'server/node_modules',
  ]),

  // Browser app source (React TypeScript) — excludes tests, which get their own config.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'src/setupTests.tsx'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { '@typescript-eslint': tseslint, local },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.app.json',
        ecmaFeatures: { jsx: true },
      },
      // `process` is here because Vite statically replaces `process.env.NODE_ENV`
      // at build time (used for test-only code paths in a few components).
      // `__APP_VERSION__` is replaced the same way — see `define` in vite.config.js.
      globals: { ...globals.browser, process: 'readonly', __APP_VERSION__: 'readonly' },
    },
    // The preset first, the shared overrides after — spread order is precedence
    // here. The other way round, recommended's bare `no-unused-vars: 'error'`
    // silently re-defaulted every option sharedTsRules configures (the ^_
    // ignore patterns, ignoreRestSiblings, caughtErrors: 'none'), in every
    // block that spreads both. Same order in all three TS blocks below.
    rules: {
      ...tseslint.configs.recommended.rules,
      ...sharedTsRules,
      'local/no-conflicting-classnames': 'error',
    },
  },

  // Vitest unit / integration tests and the shared test setup. The `js` here is
  // not decoration: the service worker and the Vite config are plain JS, so
  // their tests are too, and a {ts,tsx}-only glob left them with no rules at all.
  {
    files: ['**/*.test.{js,ts,tsx}', 'src/setupTests.tsx'],
    plugins: { '@typescript-eslint': tseslint },
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...sharedTsRules,
    },
  },

  // Node-side TypeScript: Express/Socket.IO server source files.
  {
    files: ['server/**/*.ts'],
    ignores: ['server/**/*.test.ts', 'server/**/*.integration.test.ts'],
    plugins: { '@typescript-eslint': tseslint },
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tsParser,
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.server.json',
      },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...sharedTsRules,
    },
  },

  // Node-side CommonJS: Express/Socket.IO server, migrations, .cjs scripts.
  {
    files: ['server/**/*.js', '**/*.cjs'],
    ignores: ['server/**/*.test.js', 'server/**/*.test.ts'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: sharedJsRules,
  },

  // The hand-written service worker: browser globals plus the worker-only ones
  // (self, caches, clients, skipWaiting), and no DOM.
  {
    files: ['src/sw.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.serviceworker },
      sourceType: 'module',
    },
    rules: sharedJsRules,
  },

  // Node-side ES modules: build and tool config files, the maintenance scripts,
  // and the repo-local lint rules. Anything here is `type: module` by the root
  // package.json, so a bare `*.config.js` glob was quietly excusing whole
  // directories from the lint run.
  {
    files: ['*.config.js', 'scripts/**/*.mjs', 'eslint-rules/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
    rules: sharedJsRules,
  },

  // Playwright e2e specs: Node, plus browser globals for the callbacks handed
  // to page.evaluate — those run in the page, not in the test process.
  {
    files: ['e2e/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
    },
    rules: sharedJsRules,
  },
])
