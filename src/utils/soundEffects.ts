import { useGameStore } from '../store/useGameStore';
import { supportsIOSSwitchHaptic, triggerIOSSwitchHaptic } from './iosSwitchHaptic';

// Spacing between the quick taps used to approximate a multi-pulse pattern
// via the single-tick iOS switch-haptic fallback (see below).
const IOS_SUCCESS_TAP_GAP_MS = 100;

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

// Releases the underlying audio hardware/thread instead of leaving it idle
// forever — call when the user turns sound off (see configSlice.setAudioEnabled).
// A later playTone() call transparently creates a fresh context (see
// getAudioContext's `state === 'closed'` check above).
export const closeAudioContext = async (): Promise<void> => {
  if (audioCtx && audioCtx.state !== 'closed') {
    await audioCtx.close();
  }
  audioCtx = null;
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
    // Released as soon as the tone is over. A stopped oscillator with nothing
    // referencing it is reclaimable by the spec, so this leaks nothing today —
    // but the graph is rebuilt per tone and a long game is thousands of them,
    // and `onended` is the one moment the API offers to say "done with this".
    oscillator.onended = () => {
      oscillator.disconnect();
      gainNode.disconnect();
    };
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
const YOUR_TURN_VIBRATION_PATTERN_MS = 100;
const TURN_URGENT_VIBRATION_PATTERN_MS = [30, 30, 30];

// No iOS switch-haptic fallback here by design — that trick only produces a
// single generic tap, indistinguishable from every other haptic, and a bust
// already gets its own strong audio cue (playBuzzer); not worth an
// easily-misread haptic standing in for it on iOS.
export const vibrateBust = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(BUST_VIBRATION_PATTERN_MS);
};

export const vibrateSuccess = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(SUCCESS_VIBRATION_PATTERN_MS);
    return;
  }
  if (supportsIOSSwitchHaptic()) {
    // Approximate the triple-pulse pattern with a few quick taps — a single
    // generic tick on its own loses all of that shape.
    triggerIOSSwitchHaptic();
    setTimeout(triggerIOSSwitchHaptic, IOS_SUCCESS_TAP_GAP_MS);
    setTimeout(triggerIOSSwitchHaptic, IOS_SUCCESS_TAP_GAP_MS * 2);
  }
};

// A single short pulse when it becomes your turn (online only — see Game.tsx).
export const vibrateYourTurn = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(YOUR_TURN_VIBRATION_PATTERN_MS);
    return;
  }
  if (supportsIOSSwitchHaptic()) triggerIOSSwitchHaptic();
};

// Called once per second by Game.tsx for as long as your own turn timer
// reads 10 or under (Scoreboard's isTurnTimerUrgent threshold) — this
// function itself just fires a single pulse each time it's called, on
// whichever haptic path is available.
export const vibrateTurnUrgent = (): void => {
  if (!useGameStore.getState().hapticsEnabled) return;
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(TURN_URGENT_VIBRATION_PATTERN_MS);
    return;
  }
  if (supportsIOSSwitchHaptic()) triggerIOSSwitchHaptic();
};
