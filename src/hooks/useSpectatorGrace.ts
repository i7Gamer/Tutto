import { useState, useEffect } from 'react';

interface UseSpectatorGraceOptions {
  /**
   * Whether the caller is currently in a state that might need the grace
   * period to run out — e.g. online, not my turn, no live turn state yet.
   * Going false (live state arrived, or the condition no longer applies)
   * cancels any timer in progress and resets the elapsed flag.
   */
  active: boolean;
  /**
   * Identifies WHICH wait is in progress — e.g. `${currentPlayerIndex}-${round}`.
   * A new value while `active` stays true restarts the grace period from
   * zero instead of letting the new turn inherit whatever was left of the
   * previous one's countdown.
   */
  turnKey: unknown;
  /** How long `active` must stay true (for the same turnKey) before this returns true. */
  graceMs: number;
}

/**
 * True once `active` has stayed true for `graceMs`, for the same `turnKey`.
 * See GameControls.tsx's spectator-notice branch: a room with no enforced
 * dice mode gives a spectator no way to know the active player is rolling
 * physical dice (which never pushes live turn state), so a "waiting" spinner
 * keyed only on that live state would otherwise spin for their whole turn.
 */
export function useSpectatorGrace({ active, turnKey, graceMs }: UseSpectatorGraceOptions): boolean {
  const [elapsed, setElapsed] = useState(false);

  // Syncs local timer state to `active`/`turnKey` — an external signal this
  // hook does not own — rather than state derivable at render time, the same
  // shape as the disabled cases in Statistics.tsx and App.tsx. Guarded with
  // `elapsed &&` so a no-op reset (already false — the common case) never
  // dispatches at all, rather than relying on React's same-value bailout for
  // it: an extra dispatch here, even one that changes nothing, was an extra
  // commit an unrelated render-count test elsewhere pinned against.
  useEffect(() => {
    if (!active) {
      if (elapsed) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
        setElapsed(false);
      }
      return;
    }
    // Restart from zero for this active/turnKey combination rather than
    // trusting whatever `elapsed` already held.
    if (elapsed) {
      setElapsed(false);
    }
    const timer = setTimeout(() => setElapsed(true), graceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `elapsed` is read as a guard against a redundant dispatch, not something a change to should restart the timer for.
  }, [active, turnKey, graceMs]);

  return elapsed;
}
