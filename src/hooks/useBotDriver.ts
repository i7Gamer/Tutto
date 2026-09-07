import { useEffect, useRef } from 'react';
import { BOT_REVEAL_MS, BOT_THINK_MS } from '../utils/uiTimings';

export interface UseBotDriverOptions {
  /** A bot holds this turn. Off for every human. */
  active: boolean;
  /** The table has settled and is waiting for a decision (DiceGame's canAct). */
  idle: boolean;
  /** A mid-chain drawn card is on screen, waiting to be dismissed. */
  revealPending: boolean;
  /**
   * Changes whenever the table does (the current roll's identity): a landed
   * selection is a new table, and the driver steps again on it.
   */
  tableKey: unknown;
  /** Decide on the table as it stands now: select, or act on the selection. */
  onStep: () => void;
  onDismissReveal: () => void;
}

/**
 * The clock behind a bot's turn. Nothing here knows the rules: it waits out
 * a think delay whenever the table is idle and then asks DiceGame to take one
 * step — a selection, or the action on it — and re-arms as soon as the table
 * changes. Two steps per table on purpose (see DiceGame's botStep): the
 * selection is dispatched in one render pass and acted on in the next, since
 * handleAction judges the selection the render committed, not the one just
 * dispatched.
 *
 * Handlers are read through refs so that the timer fires the handler of the
 * latest render — handleAction is rebuilt every render — without every
 * render restarting the timer.
 */
export const useBotDriver = ({
  active, idle, revealPending, tableKey, onStep, onDismissReveal,
}: UseBotDriverOptions): void => {
  const stepRef = useRef(onStep);
  const dismissRef = useRef(onDismissReveal);
  useEffect(() => {
    stepRef.current = onStep;
    dismissRef.current = onDismissReveal;
  });

  useEffect(() => {
    if (!active) return;
    if (revealPending) {
      const timer = setTimeout(() => dismissRef.current(), BOT_REVEAL_MS);
      return () => clearTimeout(timer);
    }
    if (!idle) return;
    const timer = setTimeout(() => stepRef.current(), BOT_THINK_MS);
    return () => clearTimeout(timer);
  }, [active, idle, revealPending, tableKey]);
};
