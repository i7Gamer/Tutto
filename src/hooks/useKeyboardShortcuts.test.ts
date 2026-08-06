import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

interface PressOptions {
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const press = (key: string, init: PressOptions = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
};

const focusA = (tagName: string): HTMLElement => {
  const element = document.createElement(tagName);
  if (element instanceof HTMLElement) element.tabIndex = 0;
  document.body.appendChild(element);
  element.focus();
  return element as HTMLElement;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useKeyboardShortcuts', () => {
  it('runs the handler bound to the pressed key', () => {
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));

    const event = press('r');

    expect(roll).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('matches the key regardless of case, so Shift does not break a binding', () => {
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));

    press('R');

    expect(roll).toHaveBeenCalledTimes(1);
  });

  it('binds the space bar as "space", not as the literal " "', () => {
    const primary = vi.fn();
    renderHook(() => useKeyboardShortcuts({ space: primary }));

    press(' ');

    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('leaves unbound keys to the page', () => {
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));

    const event = press('q');

    expect(roll).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('treats an undefined handler as "not available right now"', () => {
    // How a caller expresses a disabled action — the same way its button is
    // disabled — rather than binding a handler that has to re-check.
    const event = press('r');
    renderHook(() => useKeyboardShortcuts({ r: undefined }));

    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores auto-repeat from a held key', () => {
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));

    press('r', { repeat: true });

    expect(roll).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea', 'select'])('ignores keys typed into a focused %s', tagName => {
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));
    focusA(tagName);

    press('r');

    expect(roll).not.toHaveBeenCalled();
  });

  it('ignores keys while an open modal owns the keyboard', () => {
    // A React overlay does not stop a window listener the way a native
    // window.confirm() does. Every modal in this app sets aria-modal.
    const roll = vi.fn();
    renderHook(() => useKeyboardShortcuts({ r: roll }));
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    press('r');

    expect(roll).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    'leaves browser and OS chords alone (%o)',
    modifier => {
      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }));

      press('r', modifier);

      expect(roll).not.toHaveBeenCalled();
    }
  );

  it('stops listening once unmounted', () => {
    const roll = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ r: roll }));

    unmount();
    press('r');

    expect(roll).not.toHaveBeenCalled();
  });

  it('uses the newest handler after a re-render', () => {
    // The map is rebuilt every render, so a stale closure would act on the
    // previous turn's state.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useKeyboardShortcuts({ r: handler }), {
      initialProps: { handler: first },
    });

    rerender({ handler: second });
    press('r');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
