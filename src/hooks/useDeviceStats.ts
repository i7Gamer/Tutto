import { useEffect, useState } from 'react';
import { deviceStatsRequest } from '../utils/statsApi';
import { parseJsonObject } from '../utils/parseJson';
import type { GameMode } from '../types';

// The lifetime-stats fetch (EndScreen) races the server-side stats write
// triggered by the same game finish, so it retries until the data it wants
// shows up (or gives up). Lives here, next to the hook that uses them, and
// re-exported from EndScreen.tsx so its existing tests keep importing them
// from there.
export const STATS_FETCH_MAX_RETRIES = 5;
export const STATS_FETCH_RETRY_DELAY_MS = 1000;
export const STATS_FETCH_INITIAL_DELAY_MS = 500;

export type DeviceStatsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DeviceStatsRetryOptions<T> {
  maxRetries: number;
  retryDelayMs: number;
  // Delay before the very first attempt too — EndScreen's fetch races a
  // server-side write that hasn't necessarily landed the instant the game
  // ends, so even attempt zero waits this long.
  initialDelayMs: number;
  // An otherwise-successful response that isn't what the caller is waiting
  // for yet (EndScreen: the stats write for THIS game hasn't landed, so
  // gamesPlayed is still the pre-game count) is retried the same as a
  // network failure, up to maxRetries. Defaults to never (a successful parse
  // is always accepted).
  shouldRetry?: (data: T | null) => boolean;
}

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
}

export interface UseDeviceStatsResult<T> {
  stats: T | null;
  status: DeviceStatsStatus;
}

// The fetch/parse/cancel-on-unmount boilerplate that used to be written out
// three times (Game.tsx's pre-game snapshot, Statistics.tsx's personal
// bucket, EndScreen.tsx's lifetime stats, the last with a retry loop): build
// the device-stats request, check the response, parse it as JSON, and only
// apply the result if this effect run is still the current one.
//
// `stats` is not reset to null when a new fetch starts (only on an error, or
// on a fresh success) — Statistics.tsx relies on the previous bucket's
// numbers staying on screen while a newly selected bucket loads.
export function useDeviceStats<T>(
  deviceId: string | null | undefined,
  mode: GameMode,
  options: UseDeviceStatsOptions<T> = {},
): UseDeviceStatsResult<T> {
  const { enabled = true, retry } = options;
  const [stats, setStats] = useState<T | null>(null);
  const [status, setStatus] = useState<DeviceStatsStatus>('idle');

  useEffect(() => {
    if (!enabled || !deviceId) {
      // Not a response to a fetch outcome, so it can't be folded into
      // `attempt` below like every other status transition — this is the
      // hook's own status machine announcing "there is nothing to fetch",
      // same as Game.tsx's one existing case of a state update that belongs
      // in an effect because there is no render-time expression of it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('idle');
      return;
    }

    let cancelled = false;
    // Only the retrying caller (EndScreen) needs a request it can actually
    // cut short: a request left running past unmount is a phone doing work,
    // and scheduling a wakeup, for a result nobody will ever read. The other
    // two callers never retried and never aborted before this hook existed,
    // and adding a `signal` to their request would show up in tests that
    // assert the exact fetch call.
    const inFlight = retry ? new AbortController() : null;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    setStatus('loading');

    const attempt = async (retryCount: number): Promise<void> => {
      if (cancelled) return;
      const [url, init] = deviceStatsRequest(deviceId, mode);
      try {
        const res = await fetch(url, inFlight ? { ...init, signal: inFlight.signal } : init);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await parseJsonObject<T>(res);
        if (cancelled) return;

        if (retry?.shouldRetry?.(data) && retryCount < retry.maxRetries) {
          timerId = setTimeout(() => void attempt(retryCount + 1), retry.retryDelayMs);
          return;
        }
        setStats(data);
        setStatus('ready');
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('Could not fetch device stats', err);
        if (retry && retryCount < retry.maxRetries) {
          timerId = setTimeout(() => void attempt(retryCount + 1), retry.retryDelayMs);
          return;
        }
        setStats(null);
        setStatus('error');
      }
    };

    // Game.tsx and Statistics.tsx (no `retry`) fetch immediately, exactly as
    // they did before this hook existed — tests assert the fetch call within
    // a couple of flushed microtasks, with no fake timers in play. Only
    // EndScreen's retrying fetch was ever delayed, initial attempt included
    // (it races a server-side write that may not have landed yet).
    if (retry) {
      timerId = setTimeout(() => void attempt(0), retry.initialDelayMs);
    } else {
      void attempt(0);
    }

    return () => {
      cancelled = true;
      inFlight?.abort();
      clearTimeout(timerId);
    };
  }, [deviceId, mode, enabled, retry]);

  return { stats, status };
}
