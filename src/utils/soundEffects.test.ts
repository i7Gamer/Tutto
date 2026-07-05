import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playTone, playBuzzer, playSuccess, vibrateBust, vibrateSuccess, vibrateYourTurn, vibrateTurnUrgent } from './soundEffects';
import { useGameStore } from '../store/useGameStore';

describe('soundEffects', () => {
  const mockOscillator = {
    type: '',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn()
  };

  const mockGainNode = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn()
    },
    connect: vi.fn()
  };

  const mockAudioContext = {
    state: 'running',
    currentTime: 0,
    createOscillator: vi.fn(() => mockOscillator),
    createGain: vi.fn(() => mockGainNode),
    destination: {},
    resume: vi.fn().mockResolvedValue()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAudioContext.state = 'running';
    window.AudioContext = vi.fn().mockImplementation(function() { return mockAudioContext; });
    window.webkitAudioContext = undefined;
  });

  it('playTone creates and plays oscillator', async () => {
    // Force reset the module state by making it think context is closed
    mockAudioContext.state = 'closed';
    await playTone(440, 'sine', 1);
    expect(window.AudioContext).toHaveBeenCalled();
    expect(mockAudioContext.createOscillator).toHaveBeenCalled();
    expect(mockAudioContext.createGain).toHaveBeenCalled();
    expect(mockOscillator.start).toHaveBeenCalled();
    expect(mockOscillator.stop).toHaveBeenCalled();
  });

  it('resumes context if suspended', async () => {
    mockAudioContext.state = 'suspended';
    await playTone(440, 'sine', 1);
    expect(mockAudioContext.resume).toHaveBeenCalled();
  });

  it('playBuzzer plays two tones', async () => {
    playBuzzer();
    await new Promise(r => setTimeout(r, 0));
    expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('playSuccess plays three tones', async () => {
    playSuccess();
    await new Promise(r => setTimeout(r, 0));
    expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(3);
  });

  describe('vibration', () => {
    afterEach(() => {
      useGameStore.setState({ hapticsEnabled: true });
      // @ts-expect-error test-only cleanup of a jsdom-absent API
      delete navigator.vibrate;
    });

    it('vibrateBust calls navigator.vibrate when haptics are enabled and supported', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: true });

      vibrateBust();

      expect(vibrate).toHaveBeenCalledWith(200);
    });

    it('vibrateSuccess calls navigator.vibrate with a pattern when haptics are enabled', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: true });

      vibrateSuccess();

      expect(vibrate).toHaveBeenCalledWith([50, 50, 50]);
    });

    it('does not vibrate when hapticsEnabled is false', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: false });

      vibrateBust();
      vibrateSuccess();

      expect(vibrate).not.toHaveBeenCalled();
    });

    it('does not throw when navigator.vibrate is unsupported', () => {
      useGameStore.setState({ hapticsEnabled: true });
      expect(() => vibrateBust()).not.toThrow();
    });

    it('vibrateYourTurn calls navigator.vibrate when haptics are enabled', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: true });

      vibrateYourTurn();

      expect(vibrate).toHaveBeenCalledWith(100);
    });

    it('vibrateTurnUrgent calls navigator.vibrate with a pattern when haptics are enabled', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: true });

      vibrateTurnUrgent();

      expect(vibrate).toHaveBeenCalledWith([30, 30, 30]);
    });

    it('does not vibrate for the new triggers when hapticsEnabled is false', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      useGameStore.setState({ hapticsEnabled: false });

      vibrateYourTurn();
      vibrateTurnUrgent();

      expect(vibrate).not.toHaveBeenCalled();
    });
  });
});
