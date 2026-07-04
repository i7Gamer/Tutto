import { useGameStore } from '../store/useGameStore';

let audioCtx: AudioContext | null = null;

const getAudioContext = async (): Promise<AudioContext> => {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  return audioCtx;
};

export const playTone = async (
  frequency: number,
  type: OscillatorType,
  duration: number,
  vol = 0.1,
  offset = 0,
): Promise<void> => {
  if (!useGameStore.getState().audioEnabled) return;
  try {
    const ctx = await getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const startTime = ctx.currentTime + offset;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);
    gainNode.gain.setValueAtTime(0.01, startTime);
    gainNode.gain.exponentialRampToValueAtTime(vol, startTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  } catch (e) {
    console.error('Audio API not supported', e);
  }
};

export const playBuzzer = (): void => {
  void playTone(150, 'sine', 0.6, 0.15, 0);
  void playTone(140, 'sine', 0.8, 0.15, 0.1);
};

export const playSuccess = (): void => {
  void playTone(523.25, 'sine', 0.3, 0.3, 0);
  void playTone(659.25, 'sine', 0.5, 0.3, 0.15);
  void playTone(783.99, 'sine', 0.8, 0.3, 0.3);
};

const BUST_VIBRATION_PATTERN_MS = 200;
const SUCCESS_VIBRATION_PATTERN_MS = [50, 50, 50];

export const vibrateBust = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(BUST_VIBRATION_PATTERN_MS);
};

export const vibrateSuccess = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(SUCCESS_VIBRATION_PATTERN_MS);
};
