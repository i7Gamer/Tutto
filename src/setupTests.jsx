import '@testing-library/jest-dom';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => {
    return {
      t: (key) => key,
      i18n: {
        changeLanguage: () => new Promise(() => {}),
      },
    };
  },
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  }
}));

if (typeof window !== 'undefined') {
  // Mock window.scrollTo
  window.scrollTo = vi.fn();

  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock AudioContext
  class MockAudioContext {
    constructor() {
      this.state = 'suspended';
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { value: 0 },
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
  }

  window.AudioContext = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;

  // Mock Audio (HTML5 Audio)
  class MockAudio {
    play() { return Promise.resolve(); }
    pause() {}
  }
  window.Audio = MockAudio;
}

// Global fetch mock
global.__nativeFetch = global.fetch;
global.fetch = vi.fn((url) => {
  if (url === '/api/stats/global') {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ gamesPlayed: 10, totalScore: 50000 })
    });
  }
  if (url.startsWith('/api/stats/')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ gamesPlayed: 5, wins: 2 })
    });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({})
  });
});

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
