import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface UseRovingTabsOptions {
  /** How many tabs are in the group. */
  count: number;
  selectedIndex: number;
  /** Called with the new index — arrow/Home/End all activate on move
   *  (the "automatic activation" model), not just move focus. */
  onSelect: (index: number) => void;
}

export interface UseRovingTabsResult {
  /** Bind to each tab's ref prop as `setTabRef(index)` — the hook owns the
   *  underlying ref array itself, so a caller only ever hands it an index. */
  setTabRef: (index: number) => (el: HTMLElement | null) => void;
  /** 0 for the selected tab, -1 for every other — the roving tabIndex
   *  pattern, so Tab enters/leaves the group at a single stop. */
  getTabIndex: (index: number) => 0 | -1;
  /** Wire to each tab's onKeyDown, passing that tab's own index. */
  onKeyDown: (event: KeyboardEvent, index: number) => void;
}

/**
 * ArrowLeft/ArrowRight/Home/End over a one-dimensional tablist, shared by
 * Statistics.tsx's three role="tablist" rows rather than three near-copies
 * of the same handler. Wrapping is deliberate: a tablist is a closed loop,
 * not a bounded list — ArrowRight from the last tab reaches the first.
 */
export const useRovingTabs = ({ count, selectedIndex, onSelect }: UseRovingTabsOptions): UseRovingTabsResult => {
  const tabRefs = useRef<(HTMLElement | null)[]>([]);

  const focusAndSelect = (index: number) => {
    // Wraps in both directions regardless of how far index over/undershoots
    // — only ArrowLeft/ArrowRight from an end ever pass anything other than
    // +-1, but the modulo arithmetic is correct for any offset.
    const wrapped = ((index % count) + count) % count;
    onSelect(wrapped);
    tabRefs.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusAndSelect(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusAndSelect(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAndSelect(0);
        break;
      case 'End':
        event.preventDefault();
        focusAndSelect(count - 1);
        break;
      default:
        break;
    }
  };

  return {
    setTabRef: (index: number) => (el: HTMLElement | null) => { tabRefs.current[index] = el; },
    getTabIndex: (index: number) => (index === selectedIndex ? 0 : -1),
    onKeyDown,
  };
};
