/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createShutdownHandler,
  SHUTDOWN_SIGNALS,
  EXIT_CODE_OK,
  EXIT_CODE_FAILED,
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
