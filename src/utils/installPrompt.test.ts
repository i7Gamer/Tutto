import { describe, it, expect } from 'vitest';
import {
  isStandalone,
  isIosSafari,
  installPromptState,
  type InstallPromptStateInput,
} from './installPrompt';

const fakeWindow = (matches: boolean, standalone?: boolean) => ({
  matchMedia: (_query: string) => ({ matches }),
  navigator: { standalone },
});

describe('isStandalone', () => {
  it('is true when the display-mode media query matches', () => {
    expect(isStandalone(fakeWindow(true))).toBe(true);
  });

  it('is true when navigator.standalone is the iOS home-screen flag', () => {
    expect(isStandalone(fakeWindow(false, true))).toBe(true);
  });

  it('is false when neither signal is present', () => {
    expect(isStandalone(fakeWindow(false, false))).toBe(false);
  });

  it('is false when navigator.standalone is undefined (non-iOS browsers)', () => {
    expect(isStandalone(fakeWindow(false, undefined))).toBe(false);
  });
});

describe('isIosSafari', () => {
  const IPHONE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IPAD_SAFARI_UA = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IPOD_SAFARI_UA = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const IPHONE_CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1';
  const IPHONE_FIREFOX_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.2 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const DESKTOP_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

  it('is true for iPhone Safari', () => {
    expect(isIosSafari({ userAgent: IPHONE_SAFARI_UA })).toBe(true);
  });

  it('is true for iPad Safari', () => {
    expect(isIosSafari({ userAgent: IPAD_SAFARI_UA })).toBe(true);
  });

  it('is true for iPod Safari', () => {
    expect(isIosSafari({ userAgent: IPOD_SAFARI_UA })).toBe(true);
  });

  it('is false for Chrome on iOS (CriOS is still WebKit under the hood, but not Safari chrome)', () => {
    expect(isIosSafari({ userAgent: IPHONE_CHROME_UA })).toBe(false);
  });

  it('is false for Firefox on iOS', () => {
    expect(isIosSafari({ userAgent: IPHONE_FIREFOX_UA })).toBe(false);
  });

  it('is false for Android Chrome', () => {
    expect(isIosSafari({ userAgent: ANDROID_CHROME_UA })).toBe(false);
  });

  it('is false for desktop Firefox', () => {
    expect(isIosSafari({ userAgent: DESKTOP_FIREFOX_UA })).toBe(false);
  });
});

describe('installPromptState', () => {
  const BASE: InstallPromptStateInput = {
    hasEvent: false,
    dismissed: false,
    hasFinishedGame: true,
    standalone: false,
    iosSafari: false,
  };

  it('is hidden when already running standalone, even with a native event ready', () => {
    // Mutation check: remove the standalone guard from installPromptState and
    // this test must fail — a native event alone is not enough to show the
    // card once the app is already installed and running from its own icon.
    expect(installPromptState({ ...BASE, standalone: true, hasEvent: true })).toBe('hidden');
  });

  it('is hidden once the player has dismissed it', () => {
    expect(installPromptState({ ...BASE, dismissed: true, hasEvent: true })).toBe('hidden');
  });

  it('is hidden before this device has ever finished a game', () => {
    expect(installPromptState({ ...BASE, hasFinishedGame: false, hasEvent: true })).toBe('hidden');
  });

  it('is native when Chromium has offered its beforeinstallprompt event', () => {
    expect(installPromptState({ ...BASE, hasEvent: true })).toBe('native');
  });

  it('is ios on iOS Safari with no native event', () => {
    expect(installPromptState({ ...BASE, iosSafari: true })).toBe('ios');
  });

  it('is hidden on a browser with neither a native event nor iOS Safari (e.g. Firefox desktop)', () => {
    expect(installPromptState(BASE)).toBe('hidden');
  });
});
