import type { StatsRecordedForGame } from './roomTypes';

// Pending work is not a committed verdict. Weak keys also keep old finishes
// isolated from a rematch without retaining disposed rooms indefinitely.
const pendingWrites = new WeakMap<StatsRecordedForGame, Map<string, Promise<void>>>();

export const pendingDeviceStatsWrite = (game: StatsRecordedForGame, deviceId: string): Promise<void> | undefined =>
  pendingWrites.get(game)?.get(deviceId);

/** Reserve synchronously, publish the device marker only after commit. */
export const writeDeviceStatsOnce = (
  game: StatsRecordedForGame,
  deviceId: string,
  write: () => Promise<unknown>,
): Promise<void> => {
  let pending = pendingWrites.get(game);
  if (!pending) {
    pending = new Map();
    pendingWrites.set(game, pending);
  }
  if (pending.has(deviceId)) throw new Error('Device statistics write already pending');
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  pending.set(deviceId, settled);
  // Invoke immediately so the reservation and DB dispatch are one synchronous
  // operation; catch synchronous adapters as well as rejected DB promises.
  return (async () => {
    try {
      await write();
      game.devices.add(deviceId);
    } finally {
      pending.delete(deviceId);
      release();
    }
  })();
};
