import { renderHook, act } from '@testing-library/react';
import { useLayoutEffect, type PropsWithChildren } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetInstallPromptForTests, useInstallPrompt } from './useInstallPrompt';
import { localStore } from '../utils/storage';
import {
  HAS_FINISHED_GAME_KEY, INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE,
} from '../utils/installPrompt';

const IPHONE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

class FakeBeforeInstallPromptEvent extends Event {
  prompt = vi.fn(() => Promise.resolve());
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  constructor(outcome: 'accepted' | 'dismissed' = 'accepted') {
    super('beforeinstallprompt', { cancelable: true });
    this.userChoice = Promise.resolve({ outcome });
  }
}

const markFinishedGame = () => localStore.write(HAS_FINISHED_GAME_KEY, INSTALL_PROMPT_FLAG_VALUE);

const setUserAgent = (ua: string) =>
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
const originalUA = window.navigator.userAgent;

beforeEach(() => {
  localStorage.clear();
  _resetInstallPromptForTests();
});

// A failure between setUserAgent(IPHONE_SAFARI_UA) and the restore line used
// to leak the iPhone UA into every test that ran after it — the restore was
// the line right after the assertion, never reached once the assertion threw.
afterEach(() => {
  setUserAgent(originalUA);
});

describe('useInstallPrompt', () => {
  it('stays hidden before a beforeinstallprompt event arrives, even with a finished game', () => {
    markFinishedGame();

    const { result } = renderHook(() => useInstallPrompt());

    expect(result.current.state).toBe('hidden');
  });

  it('switches to native once the event arrives, and prevents the browser default mini-infobar', () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());
    const event = new FakeBeforeInstallPromptEvent();

    act(() => { window.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(result.current.state).toBe('native');
  });

  it('observes an event dispatched during the layout phase before passive subscriptions run', () => {
    markFinishedGame();
    const event = new FakeBeforeInstallPromptEvent();
    const DispatchEventDuringLayout = ({ children }: PropsWithChildren) => {
      useLayoutEffect(() => { window.dispatchEvent(event); }, []);
      return children;
    };

    const { result } = renderHook(() => useInstallPrompt(), { wrapper: DispatchEventDuringLayout });

    expect(event.defaultPrevented).toBe(true);
    expect(result.current.state).toBe('native');
  });

  it('keeps an event received while Home is unmounted for its next mount', () => {
    markFinishedGame();
    const first = renderHook(() => useInstallPrompt());
    first.unmount();
    const event = new FakeBeforeInstallPromptEvent();

    act(() => { window.dispatchEvent(event); });

    const second = renderHook(() => useInstallPrompt());
    expect(event.defaultPrevented).toBe(true);
    expect(second.result.current.state).toBe('native');
  });

  it('install() on an accepted outcome writes the dismissed flag and hides the card', async () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());
    const event = new FakeBeforeInstallPromptEvent('accepted');
    act(() => { window.dispatchEvent(event); });

    await act(async () => { await result.current.install(); });

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBe(INSTALL_PROMPT_FLAG_VALUE);
    expect(result.current.state).toBe('hidden');
  });

  it('install() on a dismissed outcome hides the card for the session without writing the flag', async () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());
    const event = new FakeBeforeInstallPromptEvent('dismissed');
    act(() => { window.dispatchEvent(event); });

    await act(async () => { await result.current.install(); });

    expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBeNull();
    expect(result.current.state).toBe('hidden');
  });

  it('calls a held browser prompt only once while its choice is pending', async () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());
    const event = new FakeBeforeInstallPromptEvent();
    let resolveChoice!: (choice: { outcome: 'accepted' | 'dismissed' }) => void;
    event.userChoice = new Promise(resolve => { resolveChoice = resolve; });
    act(() => { window.dispatchEvent(event); });

    const first = result.current.install();
    const second = result.current.install();
    expect(event.prompt).toHaveBeenCalledTimes(1);

    resolveChoice({ outcome: 'dismissed' });
    await act(async () => { await Promise.all([first, second]); });
  });

  it('install() is a no-op with no event held', async () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());

    await act(async () => { await result.current.install(); });

    expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBeNull();
  });

  it('dismiss() writes the flag and hides the card', () => {
    markFinishedGame();
    const { result } = renderHook(() => useInstallPrompt());
    const event = new FakeBeforeInstallPromptEvent();
    act(() => { window.dispatchEvent(event); });
    expect(result.current.state).toBe('native');

    act(() => { result.current.dismiss(); });

    expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBe(INSTALL_PROMPT_FLAG_VALUE);
    expect(result.current.state).toBe('hidden');
  });

  it('shows the iOS variant on Mobile Safari with no native event', () => {
    markFinishedGame();
    setUserAgent(IPHONE_SAFARI_UA);

    const { result } = renderHook(() => useInstallPrompt());

    expect(result.current.state).toBe('ios');
  });

  // The restore used to sit on the line right after the assertion above —
  // never reached if that assertion threw, leaking the iPhone UA into every
  // test that runs after it. This one would read 'ios' instead of 'hidden'
  // if that ever happened again.
  it('does not leak the iOS user agent from the previous test', () => {
    markFinishedGame();

    const { result } = renderHook(() => useInstallPrompt());

    expect(result.current.state).toBe('hidden');
  });

});
