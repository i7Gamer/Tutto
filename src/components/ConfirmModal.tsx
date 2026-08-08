import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ModalShell from './ModalShell';

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

// Shared styled replacement for window.confirm — a generic two-button
// confirm/cancel shape instead of a bespoke one-off per caller. Backdrop
// click and Escape both cancel, same as a native confirm(); ModalShell owns
// that, along with the focus handling every dialog here needs.
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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalShell
      open={open}
      onDismiss={onCancel}
      role="alertdialog"
      // Cancel gets the initial focus, not Confirm — the safe default for a
      // destructive action if the user just presses Enter.
      initialFocusRef={cancelButtonRef}
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
    </ModalShell>
  );
}
