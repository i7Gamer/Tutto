import { useState, useEffect, useRef } from 'react';
import { isTestEnv } from '../utils/env';

interface UseAutoContinueCountdownOptions {
  shouldStart: boolean;
  onElapsed: () => void;
}

export function useAutoContinueCountdown({ shouldStart, onElapsed }: UseAutoContinueCountdownOptions): number | null {
  const [countdown, setCountdown] = useState<number | null>(null);
  const startedRef = useRef(false);

  const onElapsedRef = useRef(onElapsed);
  useEffect(() => { onElapsedRef.current = onElapsed; }, [onElapsed]);

  useEffect(() => {
    if (!shouldStart || startedRef.current) return;
    startedRef.current = true;
    setCountdown(isTestEnv() ? 0 : 3);
  }, [shouldStart]);

  // The countdown reaching 0 is the single source of truth for "time's up" —
  // there used to be a second, independent 3s timer that called onElapsed on
  // its own schedule. Since that timer and this one's final tick both landed
  // on the same instant, whichever fired last always overwrote the display
  // with null before a render could ever show 0. Firing onElapsed from this
  // same effect (once the decrement reaches 0) guarantees 0 is rendered first.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      onElapsedRef.current();
      return;
    }
    const id = setTimeout(() => setCountdown(prev => (prev !== null ? prev - 1 : prev)), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  return countdown;
}
