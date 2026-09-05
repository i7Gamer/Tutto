import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// backdrop-filter is the most expensive effect the app uses: the compositor
// re-blurs everything behind the element on every frame anything on screen
// animates. On a desktop GPU that is free; on a phone it is what made the dice
// tumble stutter and every card entrance feel heavy — and the game screen
// stacks nine of them (five Scoreboard tiles, the card, the controls, the
// history, the leaderboard) under a blurred modal backdrop and a blur-xl dice
// panel. Every backdrop-blur is therefore sm:-prefixed: desktop keeps the
// look, phones get the same opaque/tinted surfaces without the blur.
const SRC = join(__dirname, '..');
const SOURCE_FILE = /\.(tsx|css)$/;
const TEST_FILE = /\.test\.[jt]sx?$/;
// A backdrop-blur utility not preceded by a variant (sm:, dark:, …).
const UNGUARDED_BLUR = /(^|[\s"'`{])backdrop-blur-/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

describe('backdrop blur is a desktop-only effect', () => {
  const files = walk(SRC);
  const offenders = files.filter((f) => UNGUARDED_BLUR.test(readFileSync(f, 'utf8')));
  const guarded = files.filter((f) => /sm:backdrop-blur-/.test(readFileSync(f, 'utf8')));

  it('never applies a backdrop-blur below the sm breakpoint', () => {
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('still uses it from sm up (the scan is not vacuous)', () => {
    expect(guarded.length).toBeGreaterThan(0);
  });
});
