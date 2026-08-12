/**
 * How long a hook may take when it has to bring real infrastructure up: a
 * spawned server (a node process, a TypeScript compile and a listen) or the
 * database.
 *
 * Vitest's 10 second default — and the 20 these suites carried — are budgets
 * for that work on an idle machine, not on a busy one. Measured: in a run that
 * took two and a half times its usual length, with every phase inflated in
 * proportion, all five of these suites' hooks timed out at once and 48 tests
 * were skipped, while nothing about the code under test had changed. Even
 * `await initDb()` against in-memory sqlite missed a 10 second budget.
 *
 * Raising it costs little of what a timeout is for: a hook that is genuinely
 * hung does not finish in thirty seconds either. What it buys is that a loaded
 * machine stops being reported as a broken test suite.
 */
export const SERVER_BOOT_TIMEOUT_MS = 30000;

/**
 * How long a hook may take to bring the database up on its own — connecting and
 * running the migrations, without a child process, a TypeScript compile or a
 * listening socket in front of it. Less work than a server boot, so it gets its
 * own, smaller budget rather than borrowing that one.
 *
 * It still needs to be more than Vitest's 10 second default: `await initDb()`
 * has been measured missing that on a loaded machine. What makes that worth
 * naming is how the miss presents — a `beforeAll` that times out marks every
 * test in the file SKIPPED, not failed, so a suite that never ran reads as a
 * green one with skips.
 */
export const DB_INIT_TIMEOUT_MS = 20000;
