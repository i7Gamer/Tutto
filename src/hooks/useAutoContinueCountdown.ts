import { useState, useEffect, useRef } from 'react';
import { isTestEnv } from '../utils/env';
import { AUTO_CONTINUE_SECONDS } from '../utils/uiTimings';

interface UseAutoContinueCountdownOptions {
  shouldStart: boolean;
  onElapsed: () => void;
  /**
   * Identifies WHAT is being counted down. A new value restarts the countdown
   * even though `shouldStart` never went false.
   *
   * The countdown used to latch on the first start, which was right for the
   * only transition it knew about — a summary opening. But a classic chain
   * whose drawn card is discarded REPLACES the summary while it is already
   * showing (DRAW_ABANDONED): the forfeit screen becomes "Tutto! Bank N
   * points", and the new summary inherited whatever was left of the old
   * countdown — possibly under a second before it auto-continued the turn.
   *
   * Left undefined the latch behaves exactly as before: the value never
   * changes, so it never restarts.
   */
  restartKey?: unknown;
}

/** No start has happened yet — distinct from any restartKey a caller may pass. */
const NOT_STARTED = Symbol('not-started');

export function useAutoContinueCountdown({ shouldStart, onElapsed, restartKey }: UseAutoContinueCountdownOptions): number | null {
  const [countdown, setCountdown] = useState<number | null>(null);
  const startedForRef = useRef<unknown>(NOT_STARTED);

  const onElapsedRef = useRef(onElapsed);
  useEffect(() => { onElapsedRef.current = onElapsed; }, [onElapsed]);

  useEffect(() => {
    if (!shouldStart || startedForRef.current === restartKey) return;
    startedForRef.current = restartKey;
    setCountdown(isTestEnv() ? 0 : AUTO_CONTINUE_SECONDS);
  }, [shouldStart, restartKey]);

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
