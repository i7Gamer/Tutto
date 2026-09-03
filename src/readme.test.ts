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
  it('mentions the Kniffel card under its German name, never as "Straight"', () => {
    // The card names are proper nouns in English too (round 7, C70); the
    // lower-case word "straight" may still describe the dice run itself.
    expect(readme).toContain('**Kniffel**');
    expect(readme).not.toContain('Kniffel (Straight)');
    expect(readme).not.toMatch(/the Straight/);
  });
});

// "Restart safety" used to say a finished game's stats "are sent by the
// host's client after the game ends" — wrong on two counts: socketSlice.ts's
// finish handler has EVERY client emit its own device stats (buildDeviceStatsPayload),
// and only the host additionally calls submitGlobalStats. A third source the
// old sentence omitted entirely: rooms.ts's recordDepartedSeatsStats writes a
// 'verdict-only' row for any seat that left, was kicked, or was disconnected
// when the game's verdict froze, since that device can never submit its own.
describe('README restart-safety stats sentence', () => {
  it('does not claim the host alone sends the stats', () => {
    expect(readme).not.toMatch(/sent by the host's client/i);
  });

  it('states each client sends its own device stats', () => {
    expect(readme).toMatch(/each client sends its own device stats/i);
  });

  it('states the host also sends the global stats', () => {
    expect(readme).toMatch(/host also sends the global stats/i);
  });

  it('states the server writes a verdict-only row for departed/disconnected seats', () => {
    expect(readme).toMatch(/verdict-only row for any seat that left or was disconnected/i);
  });
});

// "Data and backups" only ever showed the named-volume quick start, so it
// never said what a bind mount needs: the image runs as the `node` user
// (Dockerfile's USER node), whose uid/gid is 1000 on node:alpine, and a host
// directory it does not own fails to open the database at container start.
// A named volume needs no such step — Docker hands it to that user already.
describe('README data-and-backups ownership note', () => {
  it('states the bind-mount chown command', () => {
    expect(readme).toContain('chown -R 1000:1000 ./data');
  });

  it('states named volumes need no such step', () => {
    expect(readme).toMatch(/named volume.*needs? no extra setup/i);
  });
});
