import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://localhost:5173',
    // TEST_DB makes the spawned API server use an in-memory sqlite database
    // (see server/knexfile.ts) so e2e runs never read or write the real
    // stats.db. Caveat: reuseExistingServer means a locally running dev
    // server (real DB) is reused instead — kill it first when isolation
    // matters; CI always spawns fresh.
    env: { TEST_DB: 'true' },
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
