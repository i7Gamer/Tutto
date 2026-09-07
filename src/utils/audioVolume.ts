/**
 * The per-device sound level behind the lobby's volume slider.
 *
 * Kept import-free on purpose: the store's initial state needs the default,
 * and soundEffects.ts (which the store's config slice already imports for
 * closeAudioContext) needs the curve — a cycle waiting to happen if either
 * lived in the other.
 */
export const MIN_AUDIO_VOLUME = 0;
export const MAX_AUDIO_VOLUME = 1;
export const DEFAULT_AUDIO_VOLUME = MAX_AUDIO_VOLUME;
/** The slider runs 0..100; the store keeps the 0..1 fraction. */
export const VOLUME_STEPS = 100;
/**
 * Amplitude is squared so the slider feels linear: loudness tracks roughly
 * the square root of amplitude, so half the slider at half the amplitude
 * would still sound nearly full.
 */
const VOLUME_CURVE_EXPONENT = 2;

export const clampAudioVolume = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_AUDIO_VOLUME;
  return Math.min(MAX_AUDIO_VOLUME, Math.max(MIN_AUDIO_VOLUME, value));
};

/** What init() reads back from tutto_audioVolume; null means "keep the default". */
export const parseStoredAudioVolume = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampAudioVolume(parsed) : null;
};

export const volumeToGain = (volume: number): number => clampAudioVolume(volume) ** VOLUME_CURVE_EXPONENT;
