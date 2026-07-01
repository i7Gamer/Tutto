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

(globalThis as Record<string, unknown>).__nativeFetch = globalThis.fetch;
globalThis.fetch = vi.fn((url: string) => {
  if (url === '/api/stats/global') {
    return Promise.resolve({
      ok: true, json: () => Promise.resolve({ gamesPlayed: 10, totalScore: 50000 }),
    } as Response);
  }
  if (url.startsWith('/api/stats/')) {
    return Promise.resolve({
      ok: true, json: () => Promise.resolve({ gamesPlayed: 5, wins: 2 }),
    } as Response);
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
}) as unknown as typeof fetch;

(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
