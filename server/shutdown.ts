// Ordered shutdown for the production container. Without it, `docker stop`
// SIGTERMs a process that has no handler and — as PID 1, where the kernel
// applies no default disposition — nothing happens until Docker gives up and
// SIGKILLs it. The SQLite connection pool is torn down mid-flight and every
// stop costs the full grace period.
//
// The sequencing lives here rather than in index.ts so it can be tested
// without a real server, a real database or a real signal.

/** Signals that mean "stop": `docker stop` sends the first, Ctrl-C the second. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * How long Docker waits after SIGTERM before it SIGKILLs the container.
 * `docker stop`'s default, and compose's when no `stop_grace_period` is set.
 */
export const DOCKER_DEFAULT_STOP_GRACE_PERIOD_MS = 10_000;

/**
 * How long the whole sequence may take before the process exits regardless.
 * Strictly below the grace period above: an equal deadline races Docker's
 * SIGKILL, and losing that race gives exactly the outcome the watchdog exists
 * to prevent — the pool torn down mid-flight, after the full grace period.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;

export const EXIT_CODE_OK = 0;
export const EXIT_CODE_FAILED = 1;

export interface Closer {
  /** Used in the log line, so it should read as a thing, not an action. */
  name: string;
  close: () => Promise<void>;
}

interface ShutdownDependencies {
  /** Closed in order. Sockets before the database: see shutdown.test.ts. */
  closers: readonly Closer[];
  exit: (code: number) => void;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
  timeoutMs?: number;
}

export const createShutdownHandler = ({
  closers,
  exit,
  log = message => console.log(message),
  logError = (message, error) => console.error(message, error),
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}: ShutdownDependencies) => {
  let running = false;

  return async (signal: string): Promise<void> => {
    if (running) {
      log(`Received ${signal} while already shutting down — ignoring.`);
      return;
    }
    running = true;
    log(`Received ${signal}, shutting down.`);

    // A socket close can stay pending for as long as a client holds the
    // connection open, so the sequence gets a deadline of its own rather than
    // waiting for Docker's SIGKILL.
    const forcedExit = setTimeout(() => {
      logError(`Shutdown did not finish within ${timeoutMs}ms — exiting anyway.`, undefined);
      exit(EXIT_CODE_FAILED);
    }, timeoutMs);
    forcedExit.unref?.();

    let failed = false;
    for (const closer of closers) {
      try {
        await closer.close();
        log(`Closed ${closer.name}.`);
      } catch (error) {
        // Carry on: a socket server that refuses to close must not leave the
        // database handle open behind it.
        failed = true;
        logError(`Failed to close ${closer.name}:`, error);
      }
    }

    clearTimeout(forcedExit);
    exit(failed ? EXIT_CODE_FAILED : EXIT_CODE_OK);
  };
};

/**
 * Node's error code when `close()` is called on a server that never listened.
 * Reached whenever a signal arrives during startup, since the handlers are
 * registered before `server.listen()` so a `docker stop` mid-migration is
 * handled at all.
 */
const SERVER_NOT_RUNNING = 'ERR_SERVER_NOT_RUNNING';

interface ServerCloserDependencies {
  /** Closes the socket server and, with it, the HTTP server it is attached to. */
  closeSockets: (done: (error?: Error) => void) => void;
  closeDatabase: () => Promise<void>;
  /** Settles when startup — migrations, then listen — has finished or failed. */
  startup: Promise<unknown>;
}

/**
 * The production closer list, in order. Separate from index.ts so the two cases
 * that only happen during startup can be tested without a real signal.
 */
export const createServerClosers = (
  { closeSockets, closeDatabase, startup }: ServerCloserDependencies,
): Closer[] => [
  {
    name: 'socket and HTTP server',
    close: () => new Promise<void>((resolve, reject) => {
      closeSockets(error => {
        // Nothing was ever open, so there is nothing to close. Reporting it as
        // a failed closer would exit 1 on an otherwise clean shutdown.
        if (error && (error as { code?: string }).code === SERVER_NOT_RUNNING) return resolve();
        if (error) return reject(error);
        resolve();
      });
    }),
  },
  {
    name: 'database',
    close: async () => {
      // Migrations may still be in flight: destroying the pool underneath
      // knex.migrate.latest() aborts it part-applied. Startup's own failure is
      // reported by startup itself, not by this closer.
      await startup.catch(() => {});
      await closeDatabase();
    },
  },
];
