import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  playTone, playBuzzer, playSuccess, vibrateBust, vibrateSuccess, vibrateYourTurn, vibrateTurnUrgent, closeAudioContext,
  playDiceRattle, playCardSwoosh, playDieClick, playSoundPreview, DIE_CLICK_SELECT_HZ, DIE_CLICK_DESELECT_HZ,
} from './soundEffects';
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

  const mockBufferSource = {
    buffer: null as unknown,
    loop: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as null | (() => void),
  };

  const mockFilter = {
    type: '',
    frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    Q: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const MOCK_SAMPLE_RATE = 8000;

  const mockAudioContext = {
    state: 'running',
    currentTime: 0,
    sampleRate: MOCK_SAMPLE_RATE,
    createOscillator: vi.fn(() => mockOscillator),
    createGain: vi.fn(() => mockGainNode),
    createBuffer: vi.fn((_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }),
    createBufferSource: vi.fn(() => mockBufferSource),
    createBiquadFilter: vi.fn(() => mockFilter),
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(() => { mockAudioContext.state = 'closed'; return Promise.resolve(); })
  };

  beforeEach(async () => {
    // The module keeps its AudioContext across tests. Close whatever the
    // previous test left open BEFORE the mocks are cleared, so "no context
    // has been created yet" is true at the start of every test whatever the
    // order (a shuffled run, seed 3, had a rattle test leave one behind).
    await closeAudioContext();
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

  describe('audioVolume', () => {
    afterEach(() => {
      useGameStore.setState({ audioVolume: 1 });
    });

    it('scales the tone peak by the slider volume on the perceptual curve', async () => {
      useGameStore.setState({ audioVolume: 0.5 });
      await playTone(440, 'sine', 1, 0.4);
      // 0.4 * 0.5² — the ramp to the peak is the first exponential ramp
      // (the second ramps back down to the floor at the end of the tone).
      const peakRamp = mockGainNode.gain.exponentialRampToValueAtTime.mock.calls[0];
      expect(peakRamp[0]).toBeCloseTo(0.1);
    });

    it('plays nothing at all at volume zero', async () => {
      useGameStore.setState({ audioVolume: 0 });
      await playTone(440, 'sine', 1);
      expect(mockAudioContext.createOscillator).not.toHaveBeenCalled();
    });

    // The skip decision must depend only on the slider, not on a sound's own
    // vol: a fixed absolute floor (`vol * volume² <= 0.01`) used to mute the
    // quietest sound classes (playTone's own default among them) well above
    // zero — 0.15 is a slider position no earlier sound class had cleared.
    it('still plays at a low but non-zero slider position', async () => {
      useGameStore.setState({ audioVolume: 0.15 });
      await playTone(440, 'sine', 1, 0.1);
      expect(mockAudioContext.createOscillator).toHaveBeenCalled();
    });

    it('still plays the dice rattle at a low but non-zero slider position', async () => {
      useGameStore.setState({ audioVolume: 0.15 });
      await playDiceRattle(6);
      expect(mockAudioContext.createBufferSource).toHaveBeenCalled();
    });

    // The exponential ramp's floor is scaled off that sound's own peak now,
    // not a fixed absolute value — it must stay strictly below the peak even
    // when the peak itself has been scaled down to a small number by a low
    // slider position, or the ramp has nowhere to go.
    it('keeps the ramp floor below the peak even at a low slider position', async () => {
      useGameStore.setState({ audioVolume: 0.15 });
      await playTone(440, 'sine', 1, 0.1);

      const [floorAtStart] = mockGainNode.gain.setValueAtTime.mock.calls[0];
      const [peakValue] = mockGainNode.gain.exponentialRampToValueAtTime.mock.calls[0];

      expect(floorAtStart).toBeGreaterThan(0);
      expect(floorAtStart).toBeLessThan(peakValue);
    });
  });

  describe('procedural sounds', () => {
    afterEach(() => {
      useGameStore.setState({ audioEnabled: true, audioVolume: 1 });
    });

    it('playDiceRattle loops the noise buffer through a lowpass into a gain and out', async () => {
      await playDiceRattle(6);

      expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1);
      expect(mockBufferSource.loop).toBe(true);
      expect(mockBufferSource.buffer).not.toBeNull();
      expect(mockFilter.type).toBe('lowpass');
      expect(mockBufferSource.connect).toHaveBeenCalledWith(mockFilter);
      expect(mockFilter.connect).toHaveBeenCalledWith(mockGainNode);
      expect(mockGainNode.connect).toHaveBeenCalledWith(mockAudioContext.destination);
      expect(mockBufferSource.start).toHaveBeenCalledTimes(1);
      expect(mockBufferSource.stop).toHaveBeenCalledTimes(1);
    });

    it('playDiceRattle shakes once per die, and at least twice', async () => {
      await playDiceRattle(3);
      expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledTimes(3);

      vi.clearAllMocks();
      await playDiceRattle(1);
      expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledTimes(2);
    });

    it('fills the noise buffer with samples and builds it once per context', async () => {
      // The buffer is module state and an earlier test may already have built
      // it: start from no context so the count below is this test's own.
      await closeAudioContext();
      mockAudioContext.state = 'running';
      vi.clearAllMocks();

      await playDiceRattle(6);
      await playCardSwoosh();
      expect(mockAudioContext.createBuffer).toHaveBeenCalledTimes(1);
      expect(mockAudioContext.createBuffer).toHaveBeenCalledWith(1, expect.any(Number), MOCK_SAMPLE_RATE);
      const buffer = mockAudioContext.createBuffer.mock.results[0].value as { getChannelData: () => Float32Array };
      const samples = buffer.getChannelData();
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.some(v => v !== 0)).toBe(true);
      expect(samples.every(v => v >= -1 && v <= 1)).toBe(true);

      // Muting closes the context; the next sound gets a fresh context and
      // must not reuse a buffer that belonged to the closed one.
      await closeAudioContext();
      mockAudioContext.state = 'running';
      await playDiceRattle(6);
      expect(mockAudioContext.createBuffer).toHaveBeenCalledTimes(2);
    });

    it('releases the noise source, filter and gain once the sound has finished', async () => {
      await playDiceRattle(6);
      expect(typeof mockBufferSource.onended).toBe('function');

      mockBufferSource.onended!();

      expect(mockBufferSource.disconnect).toHaveBeenCalledTimes(1);
      expect(mockFilter.disconnect).toHaveBeenCalledTimes(1);
      expect(mockGainNode.disconnect).toHaveBeenCalledTimes(1);
    });

    it('playCardSwoosh sweeps a bandpass upwards over the noise', async () => {
      await playCardSwoosh();

      expect(mockFilter.type).toBe('bandpass');
      const [startHz] = mockFilter.frequency.setValueAtTime.mock.calls[0];
      const [endHz] = mockFilter.frequency.exponentialRampToValueAtTime.mock.calls[0];
      expect(endHz).toBeGreaterThan(startHz);
      expect(mockBufferSource.start).toHaveBeenCalledTimes(1);
      expect(mockBufferSource.stop).toHaveBeenCalledTimes(1);
    });

    it('playDieClick pitches a select above a deselect', async () => {
      expect(DIE_CLICK_SELECT_HZ).toBeGreaterThan(DIE_CLICK_DESELECT_HZ);

      await playDieClick(true);
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(DIE_CLICK_SELECT_HZ, expect.any(Number));

      await playDieClick(false);
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(DIE_CLICK_DESELECT_HZ, expect.any(Number));
    });

    it('stays silent when sound is off or the slider is at zero', async () => {
      useGameStore.setState({ audioEnabled: false });
      playSoundPreview();
      await playDiceRattle(6);
      await playCardSwoosh();
      await playDieClick(true);

      useGameStore.setState({ audioEnabled: true, audioVolume: 0 });
      playSoundPreview();
      await playDiceRattle(6);
      await playCardSwoosh();
      await playDieClick(true);

      expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
      expect(mockAudioContext.createOscillator).not.toHaveBeenCalled();
    });

    it('scales the noise peak by the slider volume', async () => {
      useGameStore.setState({ audioVolume: 1 });
      await playDiceRattle(6);
      const [peakAtFull] = mockGainNode.gain.exponentialRampToValueAtTime.mock.calls[0];

      vi.clearAllMocks();
      useGameStore.setState({ audioVolume: 0.5 });
      await playDiceRattle(6);
      const [peakAtHalf] = mockGainNode.gain.exponentialRampToValueAtTime.mock.calls[0];

      expect(peakAtHalf).toBeCloseTo(peakAtFull * 0.25);
    });

    it('playSoundPreview immediately plays the scoring chime without noise', async () => {
      playSoundPreview();

      await vi.waitFor(() => expect(mockAudioContext.createOscillator).toHaveBeenCalledTimes(3));
      expect(mockAudioContext.createBufferSource).not.toHaveBeenCalled();
      expect(mockOscillator.start).toHaveBeenNthCalledWith(1, mockAudioContext.currentTime);
    });
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
