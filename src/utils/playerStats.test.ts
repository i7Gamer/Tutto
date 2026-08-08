/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { zeroedPlayerStats, PLAYER_STAT_FIELDS } from './playerStats';

describe('playerStats', () => {
  it('starts every counter at zero', () => {
    for (const [field, value] of Object.entries(zeroedPlayerStats())) {
      expect(value, field).toBe(0);
    }
  });

  it('hands out a fresh set each time', () => {
    // Sharing one object would have every player in the room counting the
    // same busts — and the roster is built by mapping over names.
    const first = zeroedPlayerStats();
    const second = zeroedPlayerStats();
    first.busts = 5;

    expect(second.busts).toBe(0);
    expect(zeroedPlayerStats().busts).toBe(0);
  });

  it('names the fields it zeroes', () => {
    expect(PLAYER_STAT_FIELDS).toEqual(Object.keys(zeroedPlayerStats()));
    expect(PLAYER_STAT_FIELDS.length).toBeGreaterThan(0);
  });
});
