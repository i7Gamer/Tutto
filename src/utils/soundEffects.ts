import { useGameStore } from '../store/useGameStore';
import { supportsIOSSwitchHaptic, triggerIOSSwitchHaptic } from './iosSwitchHaptic';
import { volumeToGain } from './audioVolume';
import { TOTAL_DICE } from './turnShapes';

// Spacing between the quick taps used to approximate a multi-pulse pattern
// via the single-tick iOS switch-haptic fallback (see below).
const IOS_SUCCESS_TAP_GAP_MS = 100;
// How fast a tone swells from the floor to its peak.
const TONE_ATTACK_S = 0.02;

// Where every envelope starts and ends. An exponential ramp cannot reach 0,
// so this is also the floor a sound's peak must clear to be worth building.
const SILENT_GAIN = 0.01;

// --- Procedural sound shapes -------------------------------------------------
// One second of white noise, looped by every noise-based sound. Built once per
// context (it belongs to the context, and muting closes the context).
const NOISE_BUFFER_S = 1;
const NOISE_CHANNELS = 1;
// Dice rattle: a lowpassed noise loop pulsed once per die tumbling.
const RATTLE_LOWPASS_HZ = 900;
const RATTLE_SHAKE_S = 0.07;
const RATTLE_SHAKE_ATTACK_S = 0.01;
const RATTLE_MIN_SHAKES = 2;
const RATTLE_VOL = 0.25;
// Card swoosh: a bandpass sweeping up through the noise.
const SWOOSH_START_HZ = 400;
const SWOOSH_END_HZ = 3000;
const SWOOSH_S = 0.18;
const SWOOSH_ATTACK_S = 0.03;
const SWOOSH_Q = 1.5;
const SWOOSH_VOL = 0.2;
// Die click: a short triangle blip, higher for a select than a deselect.
export const DIE_CLICK_SELECT_HZ = 1200;
export const DIE_CLICK_DESELECT_HZ = 800;
const DIE_CLICK_S = 0.04;
const DIE_CLICK_VOL = 0.15;

let audioCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** A sound's peak gain after the lobby's volume slider — 0 means "skip it". */
const scaledPeak = (vol: number): number => vol * volumeToGain(useGameStore.getState().audioVolume);

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
  noiseBuffer = null;
};

const getNoiseBuffer = (ctx: AudioContext): AudioBuffer => {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(ctx.sampleRate * NOISE_BUFFER_S);
  const buffer = ctx.createBuffer(NOISE_CHANNELS, length, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
};

interface NoiseVoice {
  filter: BiquadFilterNode;
  gain: GainNode;
  startTime: number;
  /** Schedules the voice to stop; the nodes release themselves once it has. */
  play: (stopTime: number) => void;
}

// The noise loop -> filter -> gain -> out subgraph every noise sound is shaped
// from. Returns null when nothing should play (sound off, slider at zero, or
// no Web Audio), so callers only ever write the envelope.
const buildNoiseVoice = async (filterType: BiquadFilterType, vol: number): Promise<NoiseVoice | null> => {
  if (!useGameStore.getState().audioEnabled) return null;
  if (scaledPeak(vol) <= SILENT_GAIN) return null;
  try {
    const ctx = await getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = getNoiseBuffer(ctx);
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    const gain = ctx.createGain();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    const startTime = ctx.currentTime;
    return {
      filter,
      gain,
      startTime,
      play: (stopTime) => {
        source.start(startTime);
        source.stop(stopTime);
      },
    };
  } catch (e) {
    console.error('Audio API not supported', e);
    return null;
  }
};

const rattleShakes = (numDice: number): number => Math.max(RATTLE_MIN_SHAKES, numDice);
const rattleDurationS = (numDice: number): number => rattleShakes(numDice) * RATTLE_SHAKE_S;

/** Dice hitting the table: one pulse of lowpassed noise per die tumbling. */
export const playDiceRattle = async (numDice: number): Promise<void> => {
  const voice = await buildNoiseVoice('lowpass', RATTLE_VOL);
  if (!voice) return;
  voice.filter.frequency.setValueAtTime(RATTLE_LOWPASS_HZ, voice.startTime);
  const peak = scaledPeak(RATTLE_VOL);
  const shakes = rattleShakes(numDice);
  for (let i = 0; i < shakes; i++) {
    const shakeStart = voice.startTime + i * RATTLE_SHAKE_S;
    voice.gain.gain.setValueAtTime(SILENT_GAIN, shakeStart);
    voice.gain.gain.exponentialRampToValueAtTime(peak, shakeStart + RATTLE_SHAKE_ATTACK_S);
    voice.gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, shakeStart + RATTLE_SHAKE_S);
  }
  voice.play(voice.startTime + rattleDurationS(numDice));
};

/** A card being turned over: a bandpass sweeping up through the noise. */
export const playCardSwoosh = async (): Promise<void> => {
  const voice = await buildNoiseVoice('bandpass', SWOOSH_VOL);
  if (!voice) return;
  voice.filter.Q.value = SWOOSH_Q;
  voice.filter.frequency.setValueAtTime(SWOOSH_START_HZ, voice.startTime);
  voice.filter.frequency.exponentialRampToValueAtTime(SWOOSH_END_HZ, voice.startTime + SWOOSH_S);
  voice.gain.gain.setValueAtTime(SILENT_GAIN, voice.startTime);
  voice.gain.gain.exponentialRampToValueAtTime(scaledPeak(SWOOSH_VOL), voice.startTime + SWOOSH_ATTACK_S);
  voice.gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, voice.startTime + SWOOSH_S);
  voice.play(voice.startTime + SWOOSH_S);
};

/** Tapping a die: a blip that is a touch higher when the die is picked up than when it is put back. */
export const playDieClick = (selected: boolean): Promise<void> =>
  playTone(selected ? DIE_CLICK_SELECT_HZ : DIE_CLICK_DESELECT_HZ, 'triangle', DIE_CLICK_S, DIE_CLICK_VOL);

/** The lobby's "test sound" button: a full roll's rattle, then the scoring fanfare. */
export const playSoundPreview = (): void => {
  void playDiceRattle(TOTAL_DICE);
  playSuccess(rattleDurationS(TOTAL_DICE));
};

export const playTone = async (
  frequency: number,
  type: OscillatorType,
  duration: number,
  vol = 0.1,
  offset = 0,
): Promise<void> => {
  if (!useGameStore.getState().audioEnabled) return;
  const peak = scaledPeak(vol);
  if (peak <= SILENT_GAIN) return;
  try {
    const ctx = await getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const startTime = ctx.currentTime + offset;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);
    gainNode.gain.setValueAtTime(SILENT_GAIN, startTime);
    gainNode.gain.exponentialRampToValueAtTime(peak, startTime + TONE_ATTACK_S);
    gainNode.gain.exponentialRampToValueAtTime(SILENT_GAIN, startTime + duration);

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

export const playSuccess = (offset = 0): void => {
  void playTone(523.25, 'sine', 0.3, 0.3, offset);
  void playTone(659.25, 'sine', 0.5, 0.3, offset + 0.15);
  void playTone(783.99, 'sine', 0.8, 0.3, offset + 0.3);
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
