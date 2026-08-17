import './jest-shim';
import '@testing-library/jest-dom';
import 'jest-canvas-mock';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: () => new Promise(() => {}) },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

if (typeof window !== 'undefined') {
  window.scrollTo = vi.fn() as unknown as Window['scrollTo'];

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  class MockAudioContext {
    state = 'suspended';
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      return {
        type: 'sine' as const,
        frequency: {
          value: 0,
          setValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    createGain() {
      return {
        gain: {
          value: 1,
          exponentialRampToValueAtTime: vi.fn(),
          setValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }
    get destination() { return {} as AudioDestinationNode; }
    get currentTime() { return 0; }
  }

  window.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  window.webkitAudioContext = MockAudioContext as unknown as typeof AudioContext;

  class MockAudio {
    play() { return Promise.resolve(); }
    pause() {}
  }
  window.Audio = MockAudio as unknown as typeof Audio;
}

// HTMLCanvasElement is now mocked by jest-canvas-mock

// Guarded like the window mocks above: vite.config.ts applies this setup file
// to EVERY suite, node-environment ones included, and those talk to a real
// spawned server over a real socket. Replacing globalThis.fetch there swapped
// the runtime's own fetch for a stub that rejects anything it does not
// recognise — api.test.ts and api.routes.test.ts each carried their own
// __nativeFetch restore to undo it. `window` is what separates the two: the
// stub exists for jsdom component tests, and only they need it.
if (typeof window !== 'undefined') {
  (globalThis as Record<string, unknown>).__nativeFetch = globalThis.fetch;
  globalThis.fetch = vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
    // startsWith, not ===, because the global row carries a ?ruleset= query.
    if (url.startsWith('/api/stats/global')) {
      return Promise.resolve({
        ok: true, json: () => Promise.resolve({ gamesPlayed: 10, totalScore: 50000 }),
      } as Response);
    }
    // The device route names its device in a header, not in the path (see
    // deviceStatsRequest) — so the header is what resolves it here too, and a
    // call site that forgets it falls through to the loud rejection below.
    const deviceHeader = init?.headers?.['x-tutto-device'];
    if (url.startsWith('/api/stats/') && deviceHeader) {
      return Promise.resolve({
        ok: true, json: () => Promise.resolve({ gamesPlayed: 5, wins: 2 }),
      } as Response);
    }
    // Crash reports are fire-and-forget with their own catch (see
    // crashLog.recordCrash) — acknowledge them so intentional ErrorBoundary
    // tests don't each surface a rejected-promise distraction.
    if (url === '/api/log/client-error') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) } as Response);
    }
    // Anything else is a missing mock, not a real endpoint — fail loudly so a
    // new fetch call site can't silently ride on a fake {ok: true} response.
    return Promise.reject(new Error(`Unmocked fetch in test: ${url}`));
  }) as unknown as typeof fetch;
}

(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
