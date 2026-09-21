import { useMemo } from 'react';
import { deviceStatsRequest } from '../utils/statsApi';
import { useStatsRequest, type StatsRequestResult, type StatsRequestStatus, type StatsRetryOptions } from './useStatsRequest';
import type { GameMode } from '../types';

// The lifetime-stats fetch (EndScreen) races the server-side stats write
// triggered by the same game finish, so it retries until the data it wants
// shows up (or gives up). Lives here, next to the hook that uses them, and
// re-exported from EndScreen.tsx so its existing tests keep importing them
// from there.
export const STATS_FETCH_MAX_RETRIES = 5;
export const STATS_FETCH_RETRY_DELAY_MS = 1000;
export const STATS_FETCH_INITIAL_DELAY_MS = 500;

export type DeviceStatsStatus = StatsRequestStatus;
export type DeviceStatsRetryOptions<T> = StatsRetryOptions<T>;

export interface UseDeviceStatsOptions<T> {
  // Skips the fetch entirely (and any retry loop) when false. Defaults to
  // true; callers that only sometimes want the data (a custom game skipping
  // the pre-game snapshot, a local game skipping the lifetime fetch) pass
  // this instead of conditionally calling the hook.
  enabled?: boolean;
  // Only EndScreen's lifetime-stats fetch retries; Game.tsx's pre-game
  // snapshot and Statistics.tsx's personal bucket fetch once and accept
  // whatever comes back (matching their pre-hook behaviour exactly).
  //
  // Give this a stable identity (a module-level constant, or memoized) — it
  // sits in this hook's effect dependency array, and a fresh object literal
  // on every render would restart the fetch on every render.
  retry?: DeviceStatsRetryOptions<T>;
  // A committed statistics submission may arrive after this hook has already
  // accepted an older positive total. Changing this stable identity cancels
  // that run and fetches the matching bucket again.
  refreshKey?: string;
}

export type UseDeviceStatsResult<T> = StatsRequestResult<T>;

export function useDeviceStats<T>(
  deviceId: string | null | undefined,
  mode: GameMode,
  options: UseDeviceStatsOptions<T> = {},
): UseDeviceStatsResult<T> {
  const { enabled = true, retry, refreshKey } = options;
  const requestKey = JSON.stringify([deviceId ?? null, mode, enabled, refreshKey ?? null]);
  const request = useMemo(
    () => enabled && deviceId ? deviceStatsRequest(deviceId, mode) : null,
    [deviceId, mode, enabled],
  );
  return useStatsRequest<T>(requestKey, request, retry);
}
