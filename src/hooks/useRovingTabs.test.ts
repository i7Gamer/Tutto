import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { useRovingTabs } from './useRovingTabs';

// A focus-trackable stand-in for the real HTMLElement a tab ref would point
// at — jsdom's own .focus() works, but this also lets a test assert WHICH
// one ended up focused.
const makeFocusable = (): HTMLElement => {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
};

const fakeKeyDown = (key: string, preventDefault: () => void): KeyboardEvent =>
  ({ key, preventDefault } as unknown as KeyboardEvent);

describe('useRovingTabs', () => {
  it('gives only the selected tab a 0 tabIndex, everything else -1', () => {
    const { result } = renderHook(() => useRovingTabs({ count: 3, selectedIndex: 1, onSelect: vi.fn() }));
    expect(result.current.getTabIndex(0)).toBe(-1);
    expect(result.current.getTabIndex(1)).toBe(0);
    expect(result.current.getTabIndex(2)).toBe(-1);
  });

  it('ArrowRight selects and focuses the next tab, wrapping past the end', () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useRovingTabs({ count: 3, selectedIndex: 2, onSelect }));
    const tabs = [makeFocusable(), makeFocusable(), makeFocusable()];
    tabs.forEach((el, i) => result.current.setTabRef(i)(el));

    const preventDefault = vi.fn();
    result.current.onKeyDown(fakeKeyDown('ArrowRight', preventDefault), 2);

    expect(preventDefault).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('ArrowLeft selects and focuses the previous tab, wrapping before the start', () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useRovingTabs({ count: 3, selectedIndex: 0, onSelect }));
    const tabs = [makeFocusable(), makeFocusable(), makeFocusable()];
    tabs.forEach((el, i) => result.current.setTabRef(i)(el));

    result.current.onKeyDown(fakeKeyDown('ArrowLeft', vi.fn()), 0);

    expect(onSelect).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('Home jumps to the first tab, End jumps to the last', () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useRovingTabs({ count: 4, selectedIndex: 1, onSelect }));
    const tabs = [makeFocusable(), makeFocusable(), makeFocusable(), makeFocusable()];
    tabs.forEach((el, i) => result.current.setTabRef(i)(el));

    result.current.onKeyDown(fakeKeyDown('Home', vi.fn()), 1);
    expect(onSelect).toHaveBeenLastCalledWith(0);
    expect(document.activeElement).toBe(tabs[0]);

    result.current.onKeyDown(fakeKeyDown('End', vi.fn()), 1);
    expect(onSelect).toHaveBeenLastCalledWith(3);
    expect(document.activeElement).toBe(tabs[3]);
  });

  it('ignores keys it does not handle', () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useRovingTabs({ count: 3, selectedIndex: 0, onSelect }));
    const preventDefault = vi.fn();

    result.current.onKeyDown(fakeKeyDown('Tab', preventDefault), 0);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
