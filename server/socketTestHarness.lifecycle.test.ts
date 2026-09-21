/** @vitest-environment node */
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import {
  SERVER_BOOT_TIMEOUT_MS,
  SERVER_STARTUP_DEADLINE_MS,
  SERVER_STARTUP_HOOK_TIMEOUT_MS,
} from './testTimeouts';

const exitListenersBeforeHarnessImport = new Set(process.listeners('exit'));
const { startTestServer } = await import('./socketTestHarness');
const harnessExitListener = process.listeners('exit')
  .find(listener => !exitListenersBeforeHarnessImport.has(listener)) as (() => void) | undefined;

const PORT = '3998';
const FAKE_CHILD_PID = 1234;
const STDERR_INPUT_LENGTH = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 3_000;
const DEFAULT_EXIT_CODE = 0;
const DATABASE_MARKER_SPLIT_INDEX = 12;
const LISTENING_MARKER_SPLIT_INDEX = 5;
const LISTENING_MARKER = 'Server running on port';
const DATABASE_MARKER = 'Database migrated to the latest version';
const ERROR_MESSAGE = 'tsx initialization failed';

const READY_OUTPUT_ORDERS = [
  {
    name: 'database first',
    chunks: [
      DATABASE_MARKER.slice(0, DATABASE_MARKER_SPLIT_INDEX),
      DATABASE_MARKER.slice(DATABASE_MARKER_SPLIT_INDEX),
      LISTENING_MARKER.slice(0, LISTENING_MARKER_SPLIT_INDEX),
      LISTENING_MARKER.slice(LISTENING_MARKER_SPLIT_INDEX),
    ],
  },
  {
    name: 'listening first',
    chunks: [
      LISTENING_MARKER.slice(0, LISTENING_MARKER_SPLIT_INDEX),
      LISTENING_MARKER.slice(LISTENING_MARKER_SPLIT_INDEX),
      DATABASE_MARKER.slice(0, DATABASE_MARKER_SPLIT_INDEX),
      DATABASE_MARKER.slice(DATABASE_MARKER_SPLIT_INDEX),
    ],
  },
] as const;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  pid: number | undefined = FAKE_CHILD_PID;
}

const asChildProcess = (child: FakeChild): ChildProcess => child as unknown as ChildProcess;

describe('startTestServer startup lifecycle', () => {
  const activeChildren = new Set<FakeChild>();

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    for (const child of activeChildren) {
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', DEFAULT_EXIT_CODE, null);
      child.emit('close', DEFAULT_EXIT_CODE, null);
    }
    activeChildren.clear();
    vi.useRealTimers();
  });

  const track = (child: FakeChild): FakeChild => {
    activeChildren.add(child);
    return child;
  };

  const expectLifetimeListeners = (child: FakeChild): void => {
    expect(child.listenerCount('exit')).toBe(1);
    expect(child.listenerCount('error')).toBe(1);
    expect(child.stdout.listenerCount('data')).toBe(1);
    expect(child.stderr.listenerCount('data')).toBe(1);
  };

  it('rejects promptly when the child exits before either readiness marker, including exit code zero', async () => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT, { quietStderr: ['startup'] });

    child.stderr.write('startup failed\n');
    child.emit('exit', 0, null);

    await expect(startup).rejects.toThrow(/exited before readiness.*code 0/);
    expect(child.kill).not.toHaveBeenCalled();
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a bounded stderr tail when the child exits before readiness', async () => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT, { quietStderr: ['tsx:'] });

    child.stderr.write('tsx: '.padEnd(STDERR_INPUT_LENGTH, 'x'));
    child.emit('exit', 1, null);

    let startupError: unknown;
    try {
      await startup;
    } catch (caught) {
      startupError = caught;
    }
    expect(startupError).toBeInstanceOf(Error);
    const error = startupError as Error;
    expect(error.message).toMatch(/exited before readiness.*code 1/);
    expect(error.message.length).toBeLessThan(MAX_ERROR_MESSAGE_LENGTH);
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a synchronous spawn failure without creating a deadline', async () => {
    const error = new Error(ERROR_MESSAGE);
    spawnMock.mockImplementation(() => { throw error; });

    await expect(startTestServer(PORT)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects spawn errors and clears the deadline even when no process was created', async () => {
    const child = track(new FakeChild());
    child.pid = undefined;
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);

    child.emit('error', new Error(ERROR_MESSAGE));

    await expect(startup).rejects.toThrow(ERROR_MESSAGE);
    expect(child.kill).not.toHaveBeenCalled();
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
    expect(harnessExitListener).toBeDefined();
    harnessExitListener?.();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(READY_OUTPUT_ORDERS)('accepts readiness markers in $name across output chunks', async ({ chunks }) => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);

    for (const chunk of chunks) child.stdout.write(chunk);

    await expect(startup).resolves.toBe(asChildProcess(child));
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['listening only, exit code one', LISTENING_MARKER, 1, null],
    ['database only, SIGTERM', DATABASE_MARKER, null, 'SIGTERM'],
  ] as const)('rejects partial readiness on %s', async (_name, marker, code, signal) => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);

    child.stdout.write(marker);
    child.emit('exit', code, signal);

    const expectedDetail = code === null ? `signal ${signal}` : `code ${code}`;
    await expect(startup).rejects.toThrow(new RegExp(`exited before readiness.*${expectedDetail}`));
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills a child that stays alive without readiness and rejects before the hook budget', async () => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);

    vi.advanceTimersByTime(SERVER_STARTUP_DEADLINE_MS);

    await expect(startup).rejects.toThrow(/startup deadline/);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(SERVER_STARTUP_DEADLINE_MS).toBe(SERVER_BOOT_TIMEOUT_MS);
    expect(SERVER_STARTUP_DEADLINE_MS).toBeLessThan(SERVER_STARTUP_HOOK_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);

    expect(harnessExitListener).toBeDefined();
    harnessExitListener?.();
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit('exit', null, 'SIGTERM');
    child.kill.mockClear();
    harnessExitListener?.();
    expect(child.kill).not.toHaveBeenCalled();
    expectLifetimeListeners(child);
  });

  it('settles only once when terminal events race after a startup failure', async () => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);
    const error = new Error(ERROR_MESSAGE);

    child.emit('error', error);
    child.emit('exit', 1, null);
    child.stdout.write(LISTENING_MARKER + DATABASE_MARKER);

    await expect(startup).rejects.toBe(error);
    expect(child.kill).toHaveBeenCalledOnce();
    expectLifetimeListeners(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps lifetime output/error/reaping handling after readiness', async () => {
    const child = track(new FakeChild());
    spawnMock.mockReturnValue(asChildProcess(child));
    const startup = startTestServer(PORT);
    child.stdout.write(LISTENING_MARKER + DATABASE_MARKER);
    await expect(startup).resolves.toBe(asChildProcess(child));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    child.stderr.write('post-ready diagnostic\n');
    child.emit('error', new Error('post-ready child error'));
    child.emit('exit', 0, null);

    expect(consoleError).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expectLifetimeListeners(child);
    consoleError.mockRestore();
  });
});
