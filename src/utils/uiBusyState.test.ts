import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uiBusyState, setHasFormDraft, setStatsScreenOpen, _resetUiBusyStateForTests } from './uiBusyState';

beforeEach(() => {
  _resetUiBusyStateForTests();
});

describe('uiBusyState', () => {
  it('starts with both flags clear', () => {
    expect(uiBusyState.getState()).toEqual({ hasFormDraft: false, statsScreenOpen: false });
  });

  it('setHasFormDraft updates only that flag', () => {
    setHasFormDraft(true);
    expect(uiBusyState.getState()).toEqual({ hasFormDraft: true, statsScreenOpen: false });
  });

  it('setStatsScreenOpen updates only that flag', () => {
    setStatsScreenOpen(true);
    expect(uiBusyState.getState()).toEqual({ hasFormDraft: false, statsScreenOpen: true });
  });

  it('notifies subscribers on every change', () => {
    const listener = vi.fn();
    uiBusyState.subscribe(listener);

    setHasFormDraft(true);
    setStatsScreenOpen(true);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = uiBusyState.subscribe(listener);
    unsubscribe();

    setHasFormDraft(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it('lets independent subscribers unsubscribe independently', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = uiBusyState.subscribe(first);
    uiBusyState.subscribe(second);

    unsubscribeFirst();
    setHasFormDraft(true);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('resets both flags for the next test', () => {
    setHasFormDraft(true);
    setStatsScreenOpen(true);

    _resetUiBusyStateForTests();

    expect(uiBusyState.getState()).toEqual({ hasFormDraft: false, statsScreenOpen: false });
  });

  it('drops listeners subscribed before the reset', () => {
    // Without clearing `listeners` too, a component from a previous test that
    // never got to unmount (and so never ran its unsubscribe) keeps being
    // notified by every setter the NEXT test calls.
    const listener = vi.fn();
    uiBusyState.subscribe(listener);

    _resetUiBusyStateForTests();
    setHasFormDraft(true);

    expect(listener).not.toHaveBeenCalled();
  });
});
