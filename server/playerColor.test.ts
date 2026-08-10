/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import playerColorsData from '../playerColors.json';
import { assignPlayerColor, COLOR_RE } from './playerColor';

const PALETTE: string[] = playerColorsData.PLAYER_COLORS;

describe('COLOR_RE', () => {
  it.each(['#FF5733', '#ff5733', '#000000'])('accepts %s', (color) => {
    expect(COLOR_RE.test(color)).toBe(true);
  });

  it.each(['FF5733', '#FFF', '#gggggg', 'red', 'rgb(1,2,3)', '#FF57330'])('rejects %s', (color) => {
    expect(COLOR_RE.test(color)).toBe(false);
  });
});

describe('assignPlayerColor', () => {
  it('honors a well-formed requested colour nobody is using', () => {
    expect(assignPlayerColor('#123456', [PALETTE[0]])).toBe('#123456');
  });

  it.each([undefined, null, '', 'red', '#FFF', 42, {}])(
    'falls back to the first free palette colour when the request is not a colour (%p)',
    (requested) => {
      expect(assignPlayerColor(requested, [PALETTE[0]])).toBe(PALETTE[1]);
    },
  );

  it('takes the first free palette colour, not merely an unused index', () => {
    expect(assignPlayerColor(undefined, [PALETTE[0], PALETTE[2]])).toBe(PALETTE[1]);
  });

  it('declines a requested colour somebody at the table already wears', () => {
    // The palette walk exists to keep players visually apart; honoring a
    // saved preference that collides defeats it. A restored preference is not
    // a deliberate act — changing colour in the lobby still is, and that path
    // (updatePlayerColor) is deliberately free to collide.
    expect(assignPlayerColor(PALETTE[0], [PALETTE[0]])).toBe(PALETTE[1]);
  });

  it('is case-insensitive about that collision', () => {
    expect(assignPlayerColor(PALETTE[0].toLowerCase(), [PALETTE[0]])).toBe(PALETTE[1]);
  });

  it('keeps a taken request when the palette has nothing left to offer', () => {
    // A room may seat more players than the palette has entries — a duplicate
    // colour beats no colour, and the player's own choice beats a random one.
    expect(assignPlayerColor(PALETTE[0], [...PALETTE])).toBe(PALETTE[0]);
  });

  it('falls back to some palette colour when the palette is exhausted and no colour was asked for', () => {
    expect(PALETTE).toContain(assignPlayerColor(undefined, [...PALETTE]));
  });
});
