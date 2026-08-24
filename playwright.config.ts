import { defineConfig, devices } from '@playwright/test';

// The e2e suite runs against the production build served by the real Express
// server, not the dev server. Two reasons: it is the topology that actually
// ships (one origin serving the frontend, the API and the socket, exactly as
// the Docker image does), and the service worker only exists in a built app —
// running against `vite dev` meant offline behaviour was never exercised at
// all, which is how a worker that cached nothing went unnoticed.
const E2E_PORT = '4180';
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: E2E_ORIGIN,
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
    // Rebuilt every run: the whole point is to test the artifact, and a stale
    // dist would quietly test the previous commit.
    command: 'npm run build && npm run server',
    url: E2E_ORIGIN,
    env: {
      // A port of its own, so a dev server on 3001 is never mistaken for this
      // one — that is what made reuseExistingServer safe to turn off.
      PORT: E2E_PORT,
      // TEST_DB makes the API server use an in-memory sqlite database (see
      // server/knexfile.ts) so e2e runs never read or write the real stats.db.
      TEST_DB: 'true',
      // Every browser reaches the server from 127.0.0.1, so the per-IP socket
      // connection limiter would count them all as one client (socketHandlers.ts).
      SOCKET_CONN_LIMIT_MAX: '1000000',
      // And they all CREATE rooms from that one address, which the
      // per-address room cap (rooms.ts) would refuse past its default.
      MAX_ROOMS_PER_ADDRESS: '1000000',
    },
    // Never reuse: a server already on this port is not known to be serving a
    // fresh build, and testing yesterday's dist is worse than not testing.
    reuseExistingServer: false,
    // Covers the build as well as server start-up.
    timeout: 180000,
  },
});
