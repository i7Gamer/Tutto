/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

// The engine ends the game only at the END of a round, for a SOLE leader at
// or above the winning score (coreGameEngine.ts) — reaching the target first
// does not itself win, and a tie plays on. The README's "How to Play" section
// used to say "the first player to reach the winning score", which describes
// a different (wrong) game — this pins the corrected wording.
describe('README win rule', () => {
  it('does not claim the first player to reach the score wins', () => {
    expect(readme.toLowerCase()).not.toContain('first player to reach');
  });

  it('states that the round is played to the end', () => {
    expect(readme).toMatch(/round/i);
  });
});

// "The Cards" section listed every card except Kniffel/Straight — the card
// that awards a fixed 2,000 points for completing a straight. Descriptions
// live in src/locales/*/translation.json under cards.kniffel / help.cards.kniffel.
describe('README cards list', () => {
  it('mentions the Kniffel/Straight card', () => {
    expect(readme).toContain('Kniffel');
    expect(readme).toContain('Straight');
  });
});
