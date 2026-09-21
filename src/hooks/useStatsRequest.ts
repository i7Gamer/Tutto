import { useEffect, useState } from 'react';
import { parseJsonObject } from '../utils/parseJson';

export type StatsRequestStatus = 'idle' | 'loading' | 'ready' | 'error';
export type StatsRequest = readonly [string, RequestInit?];

export interface StatsRetryOptions<T> {
  maxRetries: number;
  retryDelayMs: number;
  initialDelayMs: number;
  // Retry successful responses while the server's just-finished write is pending.
  shouldRetry?: (data: T | null) => boolean;
}

export interface StatsRequestResult<T> {
  stats: T | null;
  status: StatsRequestStatus;
  requestKey: string;
  resultKey: string | null;
}

// Keep request/retry objects stable. A new identity or key cancels the entire
// previous run, including its in-flight fetch and any scheduled retry.
export function useStatsRequest<T>(
  requestKey: string,
  request: StatsRequest | null,
  retry?: StatsRetryOptions<T>,
): StatsRequestResult<T> {
  const [stats, setStats] = useState<T | null>(null);
  const [status, setStatus] = useState<StatsRequestStatus>('idle');
  const [resultKey, setResultKey] = useState<string | null>(null);

  useEffect(() => {
    if (!request) {
      // This transition announces that there is no request to start.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    setStatus('loading');

    const attempt = async (retryCount: number): Promise<void> => {
      if (cancelled) return;
      const [url, init] = request;
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await parseJsonObject<T>(res);
        if (cancelled) return;

        if (retry?.shouldRetry?.(data) && retryCount < retry.maxRetries) {
          timerId = setTimeout(() => void attempt(retryCount + 1), retry.retryDelayMs);
          return;
        }
        setStats(data);
        setResultKey(requestKey);
        setStatus('ready');
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('Could not fetch statistics', err);
        if (retry && retryCount < retry.maxRetries) {
          timerId = setTimeout(() => void attempt(retryCount + 1), retry.retryDelayMs);
          return;
        }
        setStats(null);
        setResultKey(requestKey);
        setStatus('error');
      }
    };

    if (retry) {
      timerId = setTimeout(() => void attempt(0), retry.initialDelayMs);
    } else {
      void attempt(0);
    }

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timerId);
    };
  }, [request, requestKey, retry]);

  // Retain the old result while loading; its key lets consumers hide it as soon
  // as their labels change, before the next effect announces loading.
  return { stats, status, requestKey, resultKey };
}
