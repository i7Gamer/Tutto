import { describe, it, expect, vi, beforeEach } from 'vitest';
import { playTone, playBuzzer, playSuccess } from './soundEffects';

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
});
