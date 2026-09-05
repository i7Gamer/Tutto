import { useState, useEffect, useRef } from 'react';
import { AUTO_CONTINUE_SECONDS } from '../utils/uiTimings';
import { MS_PER_SECOND } from '../utils/time';

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
  /**
   * How many seconds the countdown starts from. Defaults to
   * AUTO_CONTINUE_SECONDS (the dice summary's own pace) — a caller with a
   * different auto-continue duration, such as the Stop card's, passes its own
   * instead of forcing every user of this hook onto the same clock.
   */
  seconds?: number;
}

/** No start has happened yet — distinct from any restartKey a caller may pass. */
const NOT_STARTED = Symbol('not-started');

export function useAutoContinueCountdown({ shouldStart, onElapsed, restartKey, seconds = AUTO_CONTINUE_SECONDS }: UseAutoContinueCountdownOptions): number | null {
  const [countdown, setCountdown] = useState<number | null>(null);
  const startedForRef = useRef<unknown>(NOT_STARTED);

  const onElapsedRef = useRef(onElapsed);
  useEffect(() => { onElapsedRef.current = onElapsed; }, [onElapsed]);

  useEffect(() => {
    if (!shouldStart) {
      // Reset the latch too, not just the visible value: without this, a
      // LATER shouldStart with the same restartKey (e.g. a second armed
      // Stop card at the same cardsLength) would be silently ignored as
      // "already started for this key", and a caller whose restartKey never
      // changes (DiceSummary's default, undefined) could never restart at
      // all once shouldStart had gone false and come back. Guarded the same
      // way the start branch below guards its own setState: only touch state
      // the first time this effect sees shouldStart false, not on every
      // render where it happens to still be false.
      if (startedForRef.current === NOT_STARTED) return;
      startedForRef.current = NOT_STARTED;
      setCountdown(null);
      return;
    }
    if (startedForRef.current === restartKey) return;
    startedForRef.current = restartKey;
    setCountdown(seconds);
  }, [shouldStart, restartKey, seconds]);

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
    const id = setTimeout(() => setCountdown(prev => (prev !== null ? prev - 1 : prev)), MS_PER_SECOND);
    return () => clearTimeout(id);
  }, [countdown]);

  return countdown;
}
