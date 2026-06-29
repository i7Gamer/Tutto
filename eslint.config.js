import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { defineConfig, globalIgnores } from 'eslint/config'

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
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.app.json',
        ecmaFeatures: { jsx: true },
      },
      // `process` is here because Vite statically replaces `process.env.NODE_ENV`
      // at build time (used for test-only code paths in a few components).
      globals: { ...globals.browser, process: 'readonly' },
    },
    rules: {
      ...sharedTsRules,
      ...tseslint.configs.recommended.rules,
    },
  },

  // Browser app source (React JS) — legacy, removed as files are migrated.
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['**/*.test.{js,jsx}', 'src/setupTests.jsx'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, process: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: sharedJsRules,
  },

  // Vitest unit / integration tests and the shared test setup (TypeScript).
  {
    files: ['**/*.test.{ts,tsx}', 'src/setupTests.tsx'],
    plugins: { '@typescript-eslint': tseslint },
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...sharedTsRules,
      ...tseslint.configs.recommended.rules,
    },
  },

  // Vitest unit / integration tests and the shared test setup (JS, legacy).
  {
    files: ['**/*.test.{js,jsx}', 'src/setupTests.jsx'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: sharedJsRules,
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
    rules: sharedJsRules,
  },

  // Node-side ES modules: Playwright e2e specs and build/config files.
  {
    files: ['e2e/**/*.js', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
    rules: sharedJsRules,
  },
])
