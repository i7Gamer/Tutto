/**
 * Shared harness for the socket integration suites (sockets.*.test.ts).
 *
 * These suites were one 2455-line file with 53 tests. Vitest parallelises across
 * files but never within one, so that single file serialised every test it held
 * and became the slowest thing in the suite. They are now split by concern, each
 * spawning its own server on its own port: the child processes keep the groups
 * fully isolated (rooms live in one server's memory) and let them run at once.
 *
 * Ports are allocated per file and must stay unique across the whole server test
 * suite — api/socket/turnTimer/pushStateValidation already occupy 3005-3013.
 */
import { spawn, type ChildProcess } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

// TEST_TIMER_SCALE (see vite.config.js) compresses the spawned server's own
// timers, so orchestration waits in the tests have to scale with them or they
// would wait far longer than the behaviour they are pacing. Mirrors the same
// computation in turnTimers.ts and socketHandlers.ts.
const SCALE = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
export const testDelay = (ms: number) => Math.max(20, Math.floor(ms * SCALE));

/**
 * Spawns the real server as a child process and resolves once it reports BOTH
 * that it is listening and that its in-memory database finished migrating.
 * FORCE_INIT_DB makes the child run migrations so the endGameStats persistence
 * assertions observe real writes — resolving on "listening" alone would race
 * them against a half-ready database.
 */
export const startTestServer = (port: string): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const serverProcess = spawn(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), 'server/index.ts'],
      {
        env: { ...process.env, PORT: port, FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe',
      },
    );

    let stdout = '';
    let dbReady = false;
    let serverListening = false;
    const maybeResolve = () => { if (dbReady && serverListening) resolve(serverProcess); };

    serverProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
      if (stdout.includes('Server running on port')) { serverListening = true; maybeResolve(); }
      if (stdout.includes('Database migrated to the latest version')) { dbReady = true; maybeResolve(); }
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error(`Server stderr (port ${port}):`, data.toString());
    });

    serverProcess.on('error', reject);
  });
