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

/** How long the whole sequence may take before the process exits regardless. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

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
