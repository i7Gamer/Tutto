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
    //
    // Order matters and used to be wrong: the press came BEFORE renderHook,
    // so no listener existed yet and defaultPrevented was false however the
    // hook behaved.
    renderHook(() => useKeyboardShortcuts({ r: undefined }));

    const event = press('r');

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

  describe('shortcuts owned by a modal', () => {
    const openModal = (): HTMLElement => {
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      document.body.appendChild(modal);
      return modal;
    };

    it('runs a shortcut whose owner is inside the open modal', () => {
      // The dice panel is a modal that binds its own keys — blocking on "any
      // aria-modal exists" would make its own shortcuts unreachable.
      const modal = openModal();
      const owner = document.createElement('div');
      modal.appendChild(owner);

      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }, { ownerRef: { current: owner } }));

      press('r');

      expect(roll).toHaveBeenCalledTimes(1);
    });

    it('still blocks a shortcut whose owner is outside the open modal', () => {
      const modal = openModal();
      const owner = document.createElement('div');
      document.body.appendChild(owner);
      expect(modal.contains(owner)).toBe(false);

      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }, { ownerRef: { current: owner } }));

      press('r');

      expect(roll).not.toHaveBeenCalled();
    });

    it('blocks an owner inside one modal when a second modal opens on top', () => {
      // A confirm dialog over the dice panel owns the keyboard: the panel's
      // own keys must go quiet until it closes.
      const panel = openModal();
      const owner = document.createElement('div');
      panel.appendChild(owner);
      openModal(); // e.g. the End Game confirmation

      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }, { ownerRef: { current: owner } }));

      press('r');

      expect(roll).not.toHaveBeenCalled();
    });

    it('runs normally once its modal is the only one and the owner is unmounted', () => {
      // A null ref (owner not mounted yet) reads as "not inside any modal".
      openModal();
      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }, { ownerRef: { current: null } }));

      press('r');

      expect(roll).not.toHaveBeenCalled();
    });
  });

  describe('keys the focused control activates on natively', () => {
    // Tabbing to Undo or the theme toggle and pressing Enter must press THAT
    // button: swallowing the key here would run the game's primary action
    // instead of the control the keyboard user is standing on.
    const focusMarkup = (html: string): HTMLElement => {
      document.body.innerHTML = html;
      const element = document.body.firstElementChild as HTMLElement;
      element.focus();
      return element;
    };

    it.each(['Enter', ' '])('leaves "%s" to a focused button', key => {
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ enter: primary, space: primary }));
      focusMarkup('<button type="button">Undo</button>');

      const event = press(key);

      expect(primary).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it.each([
      ['a link', '<a href="#rules">Rules</a>'],
      ['a summary', '<summary tabindex="0">Details</summary>'],
      ['a role="button" element', '<div role="button" tabindex="0">Menu</div>'],
    ])('leaves Enter to %s', (_label, html) => {
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ enter: primary }));
      const element = focusMarkup(html);
      expect(document.activeElement).toBe(element);

      const event = press('Enter');

      expect(primary).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it.each([
      ['a summary', '<summary tabindex="0">Details</summary>'],
      ['a role="button" element', '<div role="button" tabindex="0">Menu</div>'],
    ])('leaves Space to %s as well', (_label, html) => {
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ space: primary }));
      focusMarkup(html);

      const event = press(' ');

      expect(primary).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('keeps Space for the game while a link is focused', () => {
      // A link is not a button: Enter follows it, Space scrolls the page.
      // Treating both keys as "the link's" loses the keystroke entirely —
      // neither the link nor the game acts on it.
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ space: primary }));
      const link = focusMarkup('<a href="#rules">Rules</a>');
      expect(document.activeElement).toBe(link);

      const event = press(' ');

      expect(primary).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps Enter when nothing is focused', () => {
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ enter: primary }));
      expect(document.activeElement).toBe(document.body);

      const event = press('Enter');

      expect(primary).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps Enter when the focused element does not activate on it', () => {
      // A focusable wrapper (the dice panel) has nothing to activate, so the
      // game keeps the key.
      const primary = vi.fn();
      renderHook(() => useKeyboardShortcuts({ enter: primary }));
      focusMarkup('<div tabindex="0">panel</div>');

      press('Enter');

      expect(primary).toHaveBeenCalledTimes(1);
    });

    it('keeps a key the focused button does not activate on', () => {
      // Only Enter and Space press a button — 'r' still has to reach the game.
      const roll = vi.fn();
      renderHook(() => useKeyboardShortcuts({ r: roll }));
      focusMarkup('<button type="button">Undo</button>');

      const event = press('r');

      expect(roll).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });
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
