import { useEffect, useRef, type RefObject } from 'react';

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

interface ShortcutOptions {
  /**
   * An element these shortcuts belong to, for callers that live INSIDE a modal
   * and bind its keys (the dice panel). Open modals containing it don't silence
   * it; ones that don't — a confirm dialog stacked on top, or any dialog when
   * this is omitted — still do.
   */
  ownerRef?: RefObject<HTMLElement | null>;
}

/**
 * Binds single-key shortcuts on the window for as long as the component lives.
 *
 * Deliberately ignores: auto-repeat from a held key, anything typed into a form
 * control, any key pressed while a modal that doesn't own these shortcuts is
 * open, and any chord with a modifier — browser and OS shortcuts keep working.
 */
export const useKeyboardShortcuts = (shortcuts: ShortcutMap, { ownerRef }: ShortcutOptions = {}): void => {
  // The map is rebuilt on every render (its handlers close over this render's
  // state), so the listener reads the latest through a ref instead of being
  // torn down and re-added each time.
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  // Same reason as shortcutsRef: read at keypress time so the listener is
  // installed once, whatever the caller passes on later renders.
  const ownerRefRef = useRef(ownerRef);
  useEffect(() => {
    ownerRefRef.current = ownerRef;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag && TEXT_ENTRY_TAGS.includes(activeTag)) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable) return;
      // Any open modal these shortcuts are not inside of owns the keyboard.
      // Scoped rather than "any modal at all" because the dice panel IS a
      // modal that binds its own keys — see ShortcutOptions.ownerRef.
      const owner = ownerRefRef.current?.current ?? null;
      const ownedByOuterModal = Array.from(document.querySelectorAll(OPEN_MODAL_SELECTOR))
        .some(modal => !owner || !modal.contains(owner));
      if (ownedByOuterModal) return;

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
