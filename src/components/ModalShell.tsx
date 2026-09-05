import { useEffect, useRef, type ReactNode, type RefObject, type KeyboardEvent, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, type MotionProps } from 'framer-motion';
import './ModalShell.css';

// Everything focusable a dialog is likely to hold. Used both to pick the
// control that gets focus on open and to work out where Tab wraps around.
// Disabled controls are excluded because they cannot take focus: counting one
// as the first or last match makes the wrap below unreachable (focus can never
// be on it), and Tab then escapes into the page behind the backdrop.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

/**
 * Keeping the page behind a dialog still.
 *
 * Module state, not component state: the lock belongs to the page, not to any
 * one dialog. A confirm stacked on the wiki closing first must not unlock the
 * page under the wiki that is still up, so the dialogs share one counter and
 * the last one out restores what was there before.
 *
 * `overflow: hidden` covers desktop and Android. It does NOT stop iOS Safari,
 * which scrolls the page anyway — that needs `position: fixed` plus saving and
 * restoring the scroll offset, which brings its own scroll-jump on close and
 * is deliberately not attempted here.
 */
// The entrance and exit every dialog gets unless its caller brings its own
// (the wiki and the dice panel do). Short: a confirm has to feel immediate,
// it only has to stop popping. MotionConfig reducedMotion="user" (App.tsx)
// turns it off for players who asked their OS for no motion.
const MODAL_TRANSITION_S = 0.15;
const PANEL_REST_SCALE = 0.95;
const PANEL_REST_OFFSET_PX = 8;
const DEFAULT_PANEL_MOTION: MotionProps = {
  initial: { opacity: 0, scale: PANEL_REST_SCALE, y: PANEL_REST_OFFSET_PX },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: PANEL_REST_SCALE, y: PANEL_REST_OFFSET_PX },
  transition: { duration: MODAL_TRANSITION_S },
};
const BACKDROP_MOTION: MotionProps = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: MODAL_TRANSITION_S },
};

let openDialogCount = 0;
let overflowBeforeLock = '';

const lockBackgroundScroll = (): (() => void) => {
  if (openDialogCount === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openDialogCount += 1;
  return () => {
    openDialogCount = Math.max(0, openDialogCount - 1);
    if (openDialogCount === 0) document.body.style.overflow = overflowBeforeLock;
  };
};

interface ModalShellProps {
  open: boolean;
  children: ReactNode;
  // Dialogs the player may walk away from pass this; the ones reporting a
  // state that cannot simply be dismissed (a lost connection) leave it out,
  // and then neither Escape nor a click outside closes them.
  onDismiss?: () => void;
  role?: 'dialog' | 'alertdialog';
  labelledBy?: string;
  // For a dialog whose heading is not always rendered — the dice panel swaps
  // its header out for the summary and the drawn-card reveal, so there is no
  // stable id to point at. Ignored when labelledBy is given: a referenced
  // heading is the more specific of the two.
  label?: string;
  // Which control should hold focus once the dialog is up. Defaults to the
  // first focusable one, which is rarely the right choice for a destructive
  // confirm — those pass their Cancel button.
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Where focus goes on close. Defaults to whatever held it when the dialog
  // opened, which is right when a click opened it and wrong when nothing did.
  returnFocusRef?: RefObject<HTMLElement | null>;
  panelClassName?: string;
  backdropClassName?: string;
  motionProps?: MotionProps;
}

/**
 * The backdrop, the panel and the keyboard behaviour every modal in the app
 * needs: focus moves in on open and back out on close, Tab stays inside, and
 * Escape closes the ones that can be closed.
 *
 * window.confirm() gave all of this for free — it is a browser-native
 * blocking dialog that owns the keyboard while it is up. Hand-built dialogs
 * are not that: without moving focus in, it stays on the trigger behind the
 * backdrop, and both Tab (which escapes into the page underneath) and Escape
 * (whose handler never receives the event) stop working.
 */
export default function ModalShell({
  open,
  children,
  onDismiss,
  role = 'dialog',
  labelledBy,
  label,
  initialFocusRef,
  returnFocusRef,
  panelClassName = 'modal-panel modal-panel-card',
  backdropClassName = 'modal-backdrop',
  motionProps = DEFAULT_PANEL_MOTION,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Shared by the open effect below and the focus-recovery handler further
  // down: the first focusable control in the panel, or the panel itself when
  // there is none (the dice panel before its dice settle).
  const getFallbackFocusTarget = (): HTMLElement | null =>
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panelRef.current;

  // Cleanup covers both ways a dialog goes away: the prop flipping to false,
  // and the whole shell unmounting while still open. Game.tsx renders the dice
  // panel as `{showDiceGame && <ModalShell open>}`, which only ever does the
  // latter — a lock tied to the prop alone would be left behind, with the page
  // unscrollable and no dialog on screen to explain why.
  useEffect(() => {
    if (!open) return;
    return lockBackgroundScroll();
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
      // The panel itself is the last resort: a dialog whose content has
      // nothing focusable yet (the dice panel, before its dice settle) would
      // otherwise leave focus on the trigger behind the backdrop — Tab then
      // walks the page underneath, and the trap below never sees a key,
      // because it is a handler on this panel.
      (initialFocusRef?.current ?? getFallbackFocusTarget())?.focus();
      return;
    }
    // A dialog that has never been open has no focus to hand back, and taking
    // it would steal focus from whatever the page is legitimately doing —
    // every closed modal in the tree would race for it on mount.
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    (returnFocusRef?.current ?? previouslyFocusedRef.current)?.focus();
    previouslyFocusedRef.current = null;
  }, [open, initialFocusRef, returnFocusRef]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      // Stopped here so an Escape meant for this dialog doesn't also reach a
      // handler on the page behind it.
      e.stopPropagation();
      onDismiss?.();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) {
      // Nothing to wrap to, but the Tab still has to be swallowed: returning
      // plainly left the browser to run its own sequential navigation, which
      // walks straight out of the panel to whatever sits behind the backdrop.
      // That is reachable in the non-dismissible dice modal during the ~1.6s
      // roll window, where every die and every action button is disabled at
      // once — and GameControls' End/Leave Game behind it stays enabled.
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    // The panel holds focus itself whenever it opened with nothing focusable
    // in it (see the fallback above) — and it keeps holding it once its
    // controls come back, because nothing moves focus on a re-render. That is
    // the dice panel every time the dice settle. The panel is neither `first`
    // nor `last`, so without this it matched no branch: a forward Tab was
    // harmless (the browser's own order goes into the panel) but Shift+Tab
    // went BACKWARDS, out of the dialog and behind the backdrop.
    const onPanelItself = document.activeElement === panelRef.current;
    if (e.shiftKey && (document.activeElement === first || onPanelItself)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // The Tab trap above only ever sees a key while focus is inside the panel.
  // A control that becomes `disabled` while it holds focus — TurnActionBar's
  // Roll/Stop, for ~1.6s while the dice tumble — is blurred by the browser to
  // <body>, outside the panel: Escape then reaches no handler and Tab walks
  // into the page behind the backdrop (GameControls' End/Leave Game). React's
  // onBlur bubbles like a native focusout, so this catches it wherever inside
  // the panel it happens and pulls focus back in.
  const handleFocusLeavingPanel = (e: FocusEvent<HTMLDivElement>): void => {
    if (!open) return;
    const next = e.relatedTarget as HTMLElement | null;
    // Focus already landed somewhere sensible: still inside this panel, or
    // inside another dialog stacked on top of it (a confirm over the dice
    // panel). That dialog must keep it — refocusing here would fight it back.
    if (next && (panelRef.current?.contains(next) || next.closest('[role="dialog"], [role="alertdialog"]'))) {
      return;
    }
    getFallbackFocusTarget()?.focus();
  };

  // Through a portal to document.body, not in place: the cards a dialog is
  // mounted from (the lobby card, the game controls, the leaderboard) carry a
  // backdrop-filter, and a backdrop-filter makes its element the containing
  // block for every position: fixed descendant — so the "fixed inset-0"
  // backdrop covered that one card instead of the page, while the same
  // ConfirmModal mounted outside a card (Home's mode switch) covered the page.
  // React context (i18n, MotionConfig) and event bubbling follow the React
  // tree, not the DOM, so nothing else about the dialog changes.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div data-testid="modal-backdrop" className={backdropClassName} onClick={() => onDismiss?.()} {...BACKDROP_MOTION}>
          <motion.div
            ref={panelRef}
            role={role}
            // Focusable only programmatically (see the fallback above), never
            // a stop in the page's own tab order.
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : label}
            className={panelClassName}
            onClick={e => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            onBlur={handleFocusLeavingPanel}
            {...motionProps}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
