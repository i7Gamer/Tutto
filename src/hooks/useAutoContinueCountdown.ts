import { useState, useEffect, useRef } from 'react';
import { isTestEnv } from '../utils/env';

interface UseAutoContinueCountdownOptions {
  shouldStart: boolean;
  onElapsed: () => void;
}

export function useAutoContinueCountdown({ shouldStart, onElapsed }: UseAutoContinueCountdownOptions): number | null {
  const [countdown, setCountdown] = useState<number | null>(null);
  const startedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onElapsedRef = useRef(onElapsed);
  useEffect(() => { onElapsedRef.current = onElapsed; }, [onElapsed]);

  useEffect(() => {
    if (!shouldStart || startedRef.current) return;
    startedRef.current = true;

    const AUTO_CONTINUE_MS = isTestEnv() ? 0 : 3000;
    setCountdown(isTestEnv() ? 0 : 3);

    timeoutRef.current = setTimeout(() => {
      setCountdown(null);
      onElapsedRef.current();
    }, AUTO_CONTINUE_MS);
  }, [shouldStart]);

  useEffect(() => () => { if (timeoutRef.current !== null) clearTimeout(timeoutRef.current); }, []);

  useEffect(() => {
    if (countdown === null || countdown <= 0 || isTestEnv()) return;
    const id = setTimeout(() => {
      setCountdown(prev => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  return countdown;
}
