/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { pendingDeviceStatsWrite, writeDeviceStatsOnce } from './statsWriteCoordinator';
import type { StatsRecordedForGame } from './roomTypes';

const deviceId = 'device';
const game = (): StatsRecordedForGame => ({ devices: new Map(), global: false });

describe('finish-scoped statistics writes', () => {
  it('reserves immediately and publishes only a committed verdict', async () => {
    const finish = game();
    let resolve!: () => void;
    const write = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const result = writeDeviceStatsOnce(finish, deviceId, 'verdict-only', write);
    expect(write).toHaveBeenCalledOnce();
    expect(finish.devices.has(deviceId)).toBe(false);
    const pending = pendingDeviceStatsWrite(finish, deviceId);
    expect(pending).toBeDefined();
    expect(() => writeDeviceStatsOnce(finish, deviceId, 'full', write)).toThrow('already pending');
    resolve();
    await result;
    await pending;
    expect(finish.devices.get(deviceId)).toBe('verdict-only');
    expect(pendingDeviceStatsWrite(finish, deviceId)).toBeUndefined();
  });

  it('releases failed writes without changing the previously committed level', async () => {
    const finish = game();
    finish.devices.set(deviceId, 'verdict-only');
    const result = writeDeviceStatsOnce(finish, deviceId, 'full', () => Promise.reject(new Error('failed')));
    const pending = pendingDeviceStatsWrite(finish, deviceId);
    await expect(result).rejects.toThrow('failed');
    await expect(pending).resolves.toBeUndefined();
    expect(finish.devices.get(deviceId)).toBe('verdict-only');
    await writeDeviceStatsOnce(finish, deviceId, 'full', async () => true);
    expect(finish.devices.get(deviceId)).toBe('full');
  });

  it('isolates rematches and devices while an old verdict is in flight', async () => {
    const old = game();
    const next = game();
    let resolve!: () => void;
    const pending = writeDeviceStatsOnce(old, deviceId, 'verdict-only', () => new Promise<void>(done => { resolve = done; }));
    await writeDeviceStatsOnce(next, deviceId, 'full', async () => true);
    await writeDeviceStatsOnce(old, 'other-device', 'full', async () => true);
    resolve();
    await pending;
    expect(next.devices.get(deviceId)).toBe('full');
    expect(old.devices.get(deviceId)).toBe('verdict-only');
  });

  it('cleans the reservation when an adapter throws synchronously', async () => {
    const finish = game();
    await expect(writeDeviceStatsOnce(finish, deviceId, 'full', () => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(pendingDeviceStatsWrite(finish, deviceId)).toBeUndefined();
    expect(finish.devices.size).toBe(0);
  });
});
