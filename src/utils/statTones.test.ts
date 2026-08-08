/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { STAT_TONES, DEFAULT_STAT_TONE } from './statTones';

describe('statTones', () => {
  const tones = Object.entries(STAT_TONES);

  it('paints both halves of every tile', () => {
    // A tone with only one half would leave a tile whose value colour and
    // surface come from different places — which is what the copied pairs
    // risked every time one of them was edited.
    for (const [name, tone] of tones) {
      expect(tone.text, name).toBeTruthy();
      expect(tone.surface, name).toBeTruthy();
    }
  });

  it('covers dark mode everywhere', () => {
    for (const [name, tone] of tones) {
      expect(tone.text, name).toContain('dark:');
      expect(tone.surface, name).toContain('dark:');
    }
  });

  it('keeps the tones distinguishable from one another', () => {
    const surfaces = tones.map(([, tone]) => tone.surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it('has a default to fall back on', () => {
    expect(STAT_TONES[DEFAULT_STAT_TONE]).toBeDefined();
  });
});
