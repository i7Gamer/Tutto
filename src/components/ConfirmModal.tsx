import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface ConfirmModalProps {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  // Red confirm button for a destructive action (end game, leave a room) —
  // matches the styling ReconnectPopup already uses for its own
  // "Return to Main Menu" button. Undo (not destructive to the game, just
  // reversible) uses the neutral indigo default instead.
  danger?: boolean;
}

// Shared styled replacement for window.confirm — same fixed-backdrop card
// pattern App.tsx's ReconnectPopup/RestoreSessionPopup already use, but a
// generic two-button confirm/cancel shape instead of a bespoke one-off per
// caller. Backdrop click and Escape both cancel, same as a native confirm().
export default function ConfirmModal({
  open,
  message,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  danger = false,
}: ConfirmModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Focus management, same pattern HelpPopup already establishes: move focus
  // into the dialog on open, back to whatever opened it on close. window.confirm()
  // used to make this safe for free — it's a real, browser-native blocking
  // dialog that steals all keyboard input, so nothing else could react to a
  // keypress while it was up. This isn't that: without moving focus in here,
  // it stays on the (now hidden-behind-the-backdrop) trigger button, which
  // breaks both Tab (escapes into the page behind the modal) and Escape (the
  // dialog's own keydown handler below never receives an event that never
  // reaches it). Cancel gets the initial focus, not Confirm — the safe
  // default for a destructive action if the user just presses Enter.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
      cancelButtonRef.current?.focus();
    } else {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  const handleDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // Trap Tab/Shift+Tab within the dialog's two buttons — same pattern
    // HelpPopup uses for its own (larger) dialog.
    const focusable = dialogRef.current.querySelectorAll<HTMLButtonElement>('button');
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
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        className="bg-white dark:bg-slate-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl border border-gray-100 dark:border-slate-700 text-center animate-bounce-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <p className="text-gray-800 dark:text-gray-100 text-lg font-medium mb-6">{message}</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            ref={cancelButtonRef}
            className="flex-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-200 font-bold py-3 px-4 rounded-xl transition-colors"
            onClick={onCancel}
          >
            {t(cancelLabel ?? 'common.cancel', 'Cancel')}
          </button>
          <button
            className={`flex-1 text-white font-bold py-3 px-4 rounded-xl transition-colors ${
              danger ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
            onClick={onConfirm}
          >
            {t(confirmLabel ?? 'common.confirm', 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
