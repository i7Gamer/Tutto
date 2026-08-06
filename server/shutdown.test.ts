/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createShutdownHandler,
  createServerClosers,
  SHUTDOWN_SIGNALS,
  EXIT_CODE_OK,
  EXIT_CODE_FAILED,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DOCKER_DEFAULT_STOP_GRACE_PERIOD_MS,
  type Closer,
} from './shutdown';

const silentLog = { log: () => {}, logError: () => {} };

const recordingCloser = (name: string, order: string[]): Closer => ({
  name,
  close: async () => {
    order.push(name);
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdownHandler', () => {
  it('closes everything in order and exits cleanly', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      closers: [recordingCloser('sockets', order), recordingCloser('database', order)],
      exit,
      ...silentLog,
    });

    await shutdown('SIGTERM');

    // Sockets before the database: a client still mid-write would otherwise
    // hit a destroyed connection pool.
    expect(order).toEqual(['sockets', 'database']);
    expect(exit).toHaveBeenCalledWith(EXIT_CODE_OK);
  });

  it('ignores a second signal while a shutdown is already running', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      closers: [recordingCloser('sockets', order)],
      exit,
      ...silentLog,
    });

    // `docker stop` follows SIGTERM with SIGKILL, but an impatient operator
    // sends Ctrl-C twice. Closing twice would destroy an already-destroyed pool.
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(order).toEqual(['sockets']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('closes the remaining resources when one closer throws, and reports failure', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      closers: [
        { name: 'sockets', close: async () => { throw new Error('already closed'); } },
        recordingCloser('database', order),
      ],
      exit,
      ...silentLog,
    });

    await shutdown('SIGTERM');

    // A failed socket close must not strand an open database handle.
    expect(order).toEqual(['database']);
    expect(exit).toHaveBeenCalledWith(EXIT_CODE_FAILED);
  });

  it('reports the failure of a later closer even when the first succeeded', async () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      closers: [
        { name: 'sockets', close: async () => {} },
        { name: 'database', close: async () => { throw new Error('pool busy'); } },
      ],
      exit,
      ...silentLog,
    });

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(EXIT_CODE_FAILED);
  });

  it('exits anyway when a closer outlives the timeout', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const timeoutMs = 5000;
    const shutdown = createShutdownHandler({
      closers: [{ name: 'hangs forever', close: () => new Promise<void>(() => {}) }],
      exit,
      timeoutMs,
      ...silentLog,
    });

    void shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    // An open WebSocket can keep a close() pending indefinitely. Without this
    // the container would sit there until Docker's own SIGKILL.
    await vi.advanceTimersByTimeAsync(timeoutMs);

    expect(exit).toHaveBeenCalledWith(EXIT_CODE_FAILED);
  });

  it('does not force-exit once shutdown has finished', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const timeoutMs = 5000;
    const shutdown = createShutdownHandler({
      closers: [{ name: 'sockets', close: async () => {} }],
      exit,
      timeoutMs,
      ...silentLog,
    });

    await shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(timeoutMs * 2);

    // The watchdog has to be cleared, or a clean shutdown reports failure.
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(EXIT_CODE_OK);
  });

  it('names the signal it received in the log', async () => {
    const log = vi.fn();
    const shutdown = createShutdownHandler({
      closers: [],
      exit: () => {},
      log,
      logError: () => {},
    });

    await shutdown('SIGTERM');

    expect(log.mock.calls.flat().join(' ')).toContain('SIGTERM');
  });
});

describe('SHUTDOWN_SIGNALS', () => {
  it('covers the signals a container and a terminal actually send', () => {
    // SIGTERM is what `docker stop` sends; SIGINT is Ctrl-C in local dev.
    expect([...SHUTDOWN_SIGNALS]).toEqual(['SIGTERM', 'SIGINT']);
  });
});

describe('DEFAULT_SHUTDOWN_TIMEOUT_MS', () => {
  it('expires before Docker gives up and SIGKILLs the container', () => {
    // Two equal deadlines race. Losing means the SIGKILL lands first, which is
    // precisely the outcome the watchdog was added to prevent — and it costs
    // the full grace period to find out.
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(DOCKER_DEFAULT_STOP_GRACE_PERIOD_MS);
  });
});

describe('createServerClosers', () => {
  const settled = Promise.resolve();
  const closedSockets = (done: (error?: Error) => void) => done();
  const serverNotRunning = (): Error =>
    Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' });

  it('closes the sockets before the database', () => {
    const closers = createServerClosers({
      closeSockets: closedSockets,
      closeDatabase: async () => {},
      startup: settled,
    });

    expect(closers.map(closer => closer.name)).toEqual(['socket and HTTP server', 'database']);
  });

  it('treats a server that never started listening as already closed', async () => {
    // The signal handlers are registered before server.listen(), so that a
    // `docker stop` during migrations is handled at all. io.close() then calls
    // back with ERR_SERVER_NOT_RUNNING, which as a closer failure would exit 1
    // on a shutdown that did nothing wrong.
    const [sockets] = createServerClosers({
      closeSockets: done => done(serverNotRunning()),
      closeDatabase: async () => {},
      startup: settled,
    });

    await expect(sockets.close()).resolves.toBeUndefined();
  });

  it('reports any other socket close error', async () => {
    const [sockets] = createServerClosers({
      closeSockets: done => done(new Error('sockets refused to close')),
      closeDatabase: async () => {},
      startup: settled,
    });

    await expect(sockets.close()).rejects.toThrow('sockets refused to close');
  });

  it('waits for startup to settle before destroying the database', async () => {
    // knex.destroy() underneath an in-flight knex.migrate.latest() aborts the
    // migration part-applied.
    let finishStartup!: () => void;
    const startup = new Promise<void>(resolve => { finishStartup = resolve; });
    const closeDatabase = vi.fn(async () => {});
    const [, database] = createServerClosers({ closeSockets: closedSockets, closeDatabase, startup });

    const closing = database.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closeDatabase).not.toHaveBeenCalled();

    finishStartup();
    await closing;
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('still closes the database when startup failed', async () => {
    const startup = Promise.reject(new Error('migrations failed'));
    startup.catch(() => {}); // the closer attaches its own handler only when it runs
    const closeDatabase = vi.fn(async () => {});
    const [, database] = createServerClosers({ closeSockets: closedSockets, closeDatabase, startup });

    await expect(database.close()).resolves.toBeUndefined();
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
