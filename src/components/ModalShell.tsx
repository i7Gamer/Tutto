import { useEffect, useRef, type ReactNode, type RefObject, type KeyboardEvent } from 'react';
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

interface ModalShellProps {
  open: boolean;
  children: ReactNode;
  // Dialogs the player may walk away from pass this; the ones reporting a
  // state that cannot simply be dismissed (a lost connection) leave it out,
  // and then neither Escape nor a click outside closes them.
  onDismiss?: () => void;
  role?: 'dialog' | 'alertdialog';
  labelledBy?: string;
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
  initialFocusRef,
  returnFocusRef,
  panelClassName = 'modal-panel modal-panel-card',
  backdropClassName = 'modal-backdrop',
  motionProps,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
      // The panel itself is the last resort: a dialog whose content has
      // nothing focusable yet (the dice panel, before its dice settle) would
      // otherwise leave focus on the trigger behind the backdrop — Tab then
      // walks the page underneath, and the trap below never sees a key,
      // because it is a handler on this panel.
      const fallback = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?? panelRef.current;
      (initialFocusRef?.current ?? fallback)?.focus();
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

  return (
    <AnimatePresence>
      {open && (
        <div data-testid="modal-backdrop" className={backdropClassName} onClick={() => onDismiss?.()}>
          <motion.div
            ref={panelRef}
            role={role}
            // Focusable only programmatically (see the fallback above), never
            // a stop in the page's own tab order.
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby={labelledBy}
            className={panelClassName}
            onClick={e => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            {...motionProps}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
