import { useEffect, useRef } from 'react';

/**
 * Single-key shortcuts, keyed by the lowercased `KeyboardEvent.key` they fire
 * on ('r', 'enter', 'space', ...). A handler of `undefined` means the action is
 * not available right now — the key is then left to the page rather than
 * swallowed, which is how a caller mirrors its own button's `disabled`.
 */
export type ShortcutMap = Record<string, (() => void) | undefined>;

/** The space bar's `key` is a single space, which no caller wants to write. */
const SPACE_KEY = ' ';
const SPACE_NAME = 'space';

// Focused elements that own their keystrokes. Buttons and links are absent on
// purpose: Enter and Space already activate a focused one natively, and the
// guards below run before any binding, so a shortcut is not double-fired.
const TEXT_ENTRY_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

// Every modal in this app sets aria-modal while it is up. A React overlay does
// not stop a window listener the way a blocking window.confirm() does, so
// without this a key pressed over a dialog reaches the game behind it.
const OPEN_MODAL_SELECTOR = '[aria-modal="true"]';

/**
 * Binds single-key shortcuts on the window for as long as the component lives.
 *
 * Deliberately ignores: auto-repeat from a held key, anything typed into a form
 * control, any key pressed while a modal is open, and any chord with a
 * modifier — browser and OS shortcuts keep working.
 */
export const useKeyboardShortcuts = (shortcuts: ShortcutMap): void => {
  // The map is rebuilt on every render (its handlers close over this render's
  // state), so the listener reads the latest through a ref instead of being
  // torn down and re-added each time.
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag && TEXT_ENTRY_TAGS.includes(activeTag)) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable) return;
      if (document.querySelector(OPEN_MODAL_SELECTOR)) return;

      const name = event.key === SPACE_KEY ? SPACE_NAME : event.key.toLowerCase();
      const handler = shortcutsRef.current[name];
      if (!handler) return;

      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
};
