/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { pendingDeviceStatsWrite, writeDeviceStatsOnce } from './statsWriteCoordinator';
import type { StatsRecordedForGame } from './roomTypes';

const deviceId = 'device';
const game = (): StatsRecordedForGame => ({ devices: new Set(), global: false });

describe('finish-scoped statistics writes', () => {
  it('reserves immediately and publishes only a committed device row', async () => {
    const finish = game();
    let resolve!: () => void;
    const write = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const result = writeDeviceStatsOnce(finish, deviceId, write);
    expect(write).toHaveBeenCalledOnce();
    expect(finish.devices.has(deviceId)).toBe(false);
    const pending = pendingDeviceStatsWrite(finish, deviceId);
    expect(pending).toBeDefined();
    expect(() => writeDeviceStatsOnce(finish, deviceId, write)).toThrow('already pending');
    resolve();
    await result;
    await pending;
    expect(finish.devices.has(deviceId)).toBe(true);
    expect(pendingDeviceStatsWrite(finish, deviceId)).toBeUndefined();
  });

  it('releases failed writes without publishing a committed row', async () => {
    const finish = game();
    const result = writeDeviceStatsOnce(finish, deviceId, () => Promise.reject(new Error('failed')));
    const pending = pendingDeviceStatsWrite(finish, deviceId);
    await expect(result).rejects.toThrow('failed');
    await expect(pending).resolves.toBeUndefined();
    expect(finish.devices.has(deviceId)).toBe(false);
    await writeDeviceStatsOnce(finish, deviceId, async () => true);
    expect(finish.devices.has(deviceId)).toBe(true);
  });

  it('isolates rematches and devices while an old verdict is in flight', async () => {
    const old = game();
    const next = game();
    let resolve!: () => void;
    const pending = writeDeviceStatsOnce(old, deviceId, () => new Promise<void>(done => { resolve = done; }));
    await writeDeviceStatsOnce(next, deviceId, async () => true);
    await writeDeviceStatsOnce(old, 'other-device', async () => true);
    resolve();
    await pending;
    expect(next.devices.has(deviceId)).toBe(true);
    expect(old.devices.has(deviceId)).toBe(true);
  });

  it('cleans the reservation when an adapter throws synchronously', async () => {
    const finish = game();
    await expect(writeDeviceStatsOnce(finish, deviceId, () => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(pendingDeviceStatsWrite(finish, deviceId)).toBeUndefined();
    expect(finish.devices.size).toBe(0);
  });
});
