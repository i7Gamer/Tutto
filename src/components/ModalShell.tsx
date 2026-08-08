import { useEffect, useRef, type ReactNode, type RefObject, type KeyboardEvent } from 'react';
import { motion, AnimatePresence, type MotionProps } from 'framer-motion';
import './ModalShell.css';

// Everything focusable a dialog is likely to hold. Used both to pick the
// control that gets focus on open and to work out where Tab wraps around.
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
      const fallback = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
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
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
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
