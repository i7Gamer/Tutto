import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

const sharedRules = {
  'no-empty': ['error', { allowEmptyCatch: true }],
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

  // Browser app source (React) — excludes tests, which get their own config.
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['**/*.test.{js,jsx}', 'src/setupTests.jsx'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      // `process` is here because Vite statically replaces `process.env.NODE_ENV`
      // at build time (used for test-only code paths in a few components).
      globals: { ...globals.browser, process: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: sharedRules,
  },

  // Vitest unit / integration tests and the shared test setup.
  {
    files: ['**/*.test.{js,jsx}', 'src/setupTests.jsx'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: sharedRules,
  },

  // Node-side CommonJS: Express/Socket.IO server, migrations, .cjs scripts.
  {
    files: ['server/**/*.js', '**/*.cjs'],
    ignores: ['server/**/*.test.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: sharedRules,
  },

  // Node-side ES modules: Playwright e2e specs and build/config files.
  {
    files: ['e2e/**/*.js', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
    rules: sharedRules,
  },
])
