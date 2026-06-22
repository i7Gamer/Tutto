import '@testing-library/jest-dom';
import { vi } from 'vitest';

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

// Global fetch mock
global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

// Mock window.prompt
window.prompt = vi.fn();

// Mock react-chartjs-2 to prevent canvas errors in JSDOM
vi.mock('react-chartjs-2', () => ({
  Line: () => <div data-testid="mock-chart">Chart</div>
}));

// Mock socket.io-client
global.mockEmit = vi.fn();
global.mockOn = vi.fn();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    emit: global.mockEmit,
    on: global.mockOn,
    off: vi.fn(),
    disconnect: vi.fn(),
  }))
}));
