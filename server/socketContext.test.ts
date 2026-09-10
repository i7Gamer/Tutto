/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeOn } from './socketContext';
import { makeFakeSocket } from './socketTestHarness';

afterEach(() => vi.restoreAllMocks());

describe('safe socket event containment', () => {
  it('passes event arguments through and contains a synchronous throw', () => {
    const fake = makeFakeSocket('safe');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('sync failure');
    const handler = vi.fn(() => { throw failure; });
    safeOn(fake.socket, 'event', handler);
    expect(() => fake.handlers.event('payload')).not.toThrow();
    expect(handler).toHaveBeenCalledWith('payload');
    expect(log).toHaveBeenCalledWith('[socket:event] handler threw:', failure);
  });

  it('returns a settled signal covering every await and catches rejection', async () => {
    const fake = makeFakeSocket('safe');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('async failure');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    safeOn(fake.socket, 'event', async () => {
      await pending;
      await Promise.resolve();
      throw failure;
    });
    const result = fake.handlers.event();
    expect(result).toBeInstanceOf(Promise);
    expect(log).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[socket:event] handler rejected:', failure);
  });

  it('accepts successful synchronous and asynchronous handlers', async () => {
    const fake = makeFakeSocket('safe');
    safeOn(fake.socket, 'sync', () => undefined);
    safeOn(fake.socket, 'async', async () => undefined);
    expect(fake.handlers.sync()).toBeUndefined();
    await expect(fake.handlers.async()).resolves.toBeUndefined();
  });
});
