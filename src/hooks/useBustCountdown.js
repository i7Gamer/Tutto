import { useState, useEffect, useRef } from 'react';
import { isTestEnv } from '../utils/env';

// Drives the "Continuing in N…" auto-advance shown after a losing bust.
//
// Starts exactly once when `shouldStart` first becomes true, counts down from 3,
// then invokes `onElapsed`. `onElapsed` is held in a ref so parent re-renders
// (e.g. a changing onComplete identity) never cancel the running timer. In test
// mode the countdown collapses to 0 and fires immediately.
//
// Returns the current countdown value (3→1, or 0 in test mode, null when idle).
export function useBustCountdown({ shouldStart, onElapsed }) {
  const [bustCountdown, setBustCountdown] = useState(null);
  const startedRef = useRef(false);
  const timeoutRef = useRef(null);

  const onElapsedRef = useRef(onElapsed);
  useEffect(() => { onElapsedRef.current = onElapsed; }, [onElapsed]);

  // Main timer: starts once, then calls onElapsed when elapsed. The timeout is
  // held in a ref and only cleared on unmount, so neither re-renders nor a
  // toggling `shouldStart` can cancel an in-flight countdown.
  useEffect(() => {
    if (!shouldStart || startedRef.current) return;
    startedRef.current = true;

    const AUTO_CONTINUE_MS = isTestEnv() ? 0 : 3000;
    setBustCountdown(isTestEnv() ? 0 : 3);

    timeoutRef.current = setTimeout(() => {
      setBustCountdown(null);
      onElapsedRef.current();
    }, AUTO_CONTINUE_MS);
  }, [shouldStart]);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  // Countdown tick: decrements once per second while counting. Runs independently
  // of the main timer so re-renders don't kill the timeout.
  useEffect(() => {
    if (bustCountdown === null || bustCountdown <= 0 || isTestEnv()) return;
    const id = setTimeout(() => {
      setBustCountdown(prev => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
    return () => clearTimeout(id);
  }, [bustCountdown]);

  return bustCountdown;
}
