/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { BOT_PERSONALITIES } from '../types';
import { BOT_NAMES, isBotPersonality, botOf } from './bots';
import { MAX_PLAYER_NAME_LENGTH } from './configValidation';
import { makePlayer } from '../testing/factories';

describe('bots', () => {
  it('names every personality, distinctly, within the roster name cap', () => {
    expect(BOT_PERSONALITIES).toEqual(['cautious', 'risky', 'optimal']);
    const names = BOT_PERSONALITIES.map(p => BOT_NAMES[p]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(MAX_PLAYER_NAME_LENGTH);
    }
  });

  it('isBotPersonality accepts only the three personalities', () => {
    for (const p of BOT_PERSONALITIES) expect(isBotPersonality(p)).toBe(true);
    expect(isBotPersonality('sneaky')).toBe(false);
    expect(isBotPersonality(undefined)).toBe(false);
    expect(isBotPersonality(null)).toBe(false);
    expect(isBotPersonality(3)).toBe(false);
  });

  it('botOf reads a seat\'s personality and ignores a corrupt one', () => {
    expect(botOf(makePlayer({ name: 'Alice' }))).toBeNull();
    expect(botOf(makePlayer({ name: 'Carl', bot: 'cautious' }))).toBe('cautious');
    // A hand-edited save can hold anything a string field allows.
    expect(botOf(makePlayer({ name: 'X', bot: 'sneaky' as never }))).toBeNull();
    expect(botOf(null)).toBeNull();
    expect(botOf(undefined)).toBeNull();
  });
});
