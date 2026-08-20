import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playTone, playBuzzer, playSuccess, vibrateBust, vibrateSuccess, vibrateYourTurn, vibrateTurnUrgent, closeAudioContext } from './soundEffects';
import { useGameStore } from '../store/useGameStore';
import { supportsIOSSwitchHaptic, triggerIOSSwitchHaptic } from './iosSwitchHaptic';

vi.mock('./iosSwitchHaptic', () => ({
  supportsIOSSwitchHaptic: vi.fn(),
  triggerIOSSwitchHaptic: vi.fn(),
}));

describe('soundEffects', () => {
  const mockOscillator = {
    type: '',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as null | (() => void),
  };

  const mockGainNode = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn()
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockAudioContext = {
    state: 'running',
    currentTime: 0,
    createOscillator: vi.fn(() => mockOscillator),
    createGain: vi.fn(() => mockGainNode),
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(() => { mockAudioContext.state = 'closed'; return Promise.resolve(); })
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

  // Every tone builds a fresh oscillator and gain and wires them into the
  // context. Once the oscillator has stopped, that little subgraph is finished
  // — the spec lets a browser reclaim it, but nothing here said so, and a long
  // game is thousands of tones. Releasing it on `onended` is the one moment
  // the Web Audio API offers to do it.
  it('releases the oscillator and gain once the tone has finished', async () => {
    mockAudioContext.state = 'closed';
    await playTone(440, 'sine', 1);

    expect(mockOscillator.disconnect).not.toHaveBeenCalled();
    expect(typeof mockOscillator.onended).toBe('function');

    mockOscillator.onended!();

    expect(mockOscillator.disconnect).toHaveBeenCalledTimes(1);
    expect(mockGainNode.disconnect).toHaveBeenCalledTimes(1);
  });

  it('playBuzzer plays two tones', async () => {
    playBuzzer();
    // Waited on the count rather than on one macrotask tick: playTone awaits
    // getAudioContext before it builds anything, and a tick that happens to
    // drain that today would stop draining it the moment another await is
    // added — silently, since the assertion would then read 0.
    await vi.waitFor(() => expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(2));
  });

  it('playSuccess plays three tones', async () => {
    playSuccess();
    await vi.waitFor(() => expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(3));
  });

  describe('closeAudioContext', () => {
    it('closes the underlying AudioContext once one has been created', async () => {
      await playTone(440, 'sine', 1);
      expect(mockAudioContext.close).not.toHaveBeenCalled();

      await closeAudioContext();

      expect(mockAudioContext.close).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no AudioContext has been created yet', async () => {
      await closeAudioContext();
      expect(mockAudioContext.close).not.toHaveBeenCalled();
    });

    it('is a no-op when the context is already closed', async () => {
      mockAudioContext.state = 'closed';
      await playTone(440, 'sine', 1); // creates a fresh context (state starts 'closed' above)
      mockAudioContext.state = 'closed';
      mockAudioContext.close.mockClear();

      await closeAudioContext();

      expect(mockAudioContext.close).not.toHaveBeenCalled();
    });

    it('lets a subsequent playTone create a fresh context after closing', async () => {
      await playTone(440, 'sine', 1);
      await closeAudioContext();

      mockAudioContext.state = 'running';
      const callsBefore = (window.AudioContext as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      await playTone(440, 'sine', 1);

      expect((window.AudioContext as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    });
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

  describe('iOS switch-haptic fallback (no navigator.vibrate)', () => {
    beforeEach(() => {
      // @ts-expect-error test-only cleanup of a jsdom-absent API
      delete navigator.vibrate;
      useGameStore.setState({ hapticsEnabled: true });
      vi.mocked(supportsIOSSwitchHaptic).mockReturnValue(true);
    });

    afterEach(() => {
      useGameStore.setState({ hapticsEnabled: true });
      vi.mocked(triggerIOSSwitchHaptic).mockClear();
      vi.mocked(supportsIOSSwitchHaptic).mockReset();
    });

    it('vibrateBust does NOT fall back to the iOS switch trick — by design', () => {
      vibrateBust();
      expect(triggerIOSSwitchHaptic).not.toHaveBeenCalled();
    });

    it('vibrateSuccess taps the switch three times to approximate the pulse pattern', () => {
      vi.useFakeTimers();
      try {
        vibrateSuccess();
        expect(triggerIOSSwitchHaptic).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(100);
        expect(triggerIOSSwitchHaptic).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(100);
        expect(triggerIOSSwitchHaptic).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('vibrateYourTurn taps the switch once', () => {
      vibrateYourTurn();
      expect(triggerIOSSwitchHaptic).toHaveBeenCalledTimes(1);
    });

    it('vibrateTurnUrgent taps the switch once per call', () => {
      vibrateTurnUrgent();
      expect(triggerIOSSwitchHaptic).toHaveBeenCalledTimes(1);
    });

    it('does not use the switch trick when it is unsupported', () => {
      vi.mocked(supportsIOSSwitchHaptic).mockReturnValue(false);

      vibrateSuccess();
      vibrateYourTurn();
      vibrateTurnUrgent();

      expect(triggerIOSSwitchHaptic).not.toHaveBeenCalled();
    });

    it('does not use the switch trick when hapticsEnabled is false', () => {
      useGameStore.setState({ hapticsEnabled: false });

      vibrateSuccess();
      vibrateYourTurn();
      vibrateTurnUrgent();

      expect(triggerIOSSwitchHaptic).not.toHaveBeenCalled();
    });
  });
});
