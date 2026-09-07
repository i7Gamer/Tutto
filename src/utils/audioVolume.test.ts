/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUDIO_VOLUME, MIN_AUDIO_VOLUME, MAX_AUDIO_VOLUME,
  clampAudioVolume, parseStoredAudioVolume, volumeToGain, VOLUME_STEPS,
} from './audioVolume';

describe('audioVolume', () => {
  it('defaults to full volume inside the allowed range', () => {
    expect(DEFAULT_AUDIO_VOLUME).toBe(MAX_AUDIO_VOLUME);
    expect(MIN_AUDIO_VOLUME).toBe(0);
    expect(MAX_AUDIO_VOLUME).toBe(1);
    expect(VOLUME_STEPS).toBe(100);
  });

  describe('clampAudioVolume', () => {
    it('keeps a value inside the range as it is', () => {
      expect(clampAudioVolume(0.37)).toBe(0.37);
      expect(clampAudioVolume(0)).toBe(0);
      expect(clampAudioVolume(1)).toBe(1);
    });

    it('clamps values outside the range', () => {
      expect(clampAudioVolume(1.7)).toBe(MAX_AUDIO_VOLUME);
      expect(clampAudioVolume(-2)).toBe(MIN_AUDIO_VOLUME);
    });

    it('falls back to the default for a non-finite value', () => {
      expect(clampAudioVolume(Number.NaN)).toBe(DEFAULT_AUDIO_VOLUME);
      expect(clampAudioVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AUDIO_VOLUME);
    });
  });

  describe('parseStoredAudioVolume', () => {
    it('reads a stored decimal and clamps it', () => {
      expect(parseStoredAudioVolume('0.25')).toBe(0.25);
      expect(parseStoredAudioVolume('3')).toBe(MAX_AUDIO_VOLUME);
      expect(parseStoredAudioVolume('-1')).toBe(MIN_AUDIO_VOLUME);
    });

    it('returns null for a missing or unreadable value so the default stays', () => {
      expect(parseStoredAudioVolume(null)).toBeNull();
      expect(parseStoredAudioVolume('')).toBeNull();
      expect(parseStoredAudioVolume('loud')).toBeNull();
    });
  });

  describe('volumeToGain', () => {
    it('is silent at zero, full at one, and perceptually curved between', () => {
      expect(volumeToGain(0)).toBe(0);
      expect(volumeToGain(1)).toBe(1);
      // Squared: half the slider is a quarter of the amplitude, which the ear
      // hears as roughly half as loud.
      expect(volumeToGain(0.5)).toBeCloseTo(0.25);
    });
  });
});
