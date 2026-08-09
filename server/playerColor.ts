import playerColorsData from '../playerColors.json';

const { PLAYER_COLORS } = playerColorsData;

/** The only colour format a client may ask for: `#rrggbb`. */
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/i;

/**
 * The colour a joining player gets: the one they asked for if it is well
 * formed, otherwise the first of the palette nobody at the table is using, and
 * failing that any of them — a room can seat more players than the palette has
 * entries, and a duplicate colour beats no colour.
 */
export const assignPlayerColor = (requested: unknown, usedColors: string[]): string => {
  if (typeof requested === 'string' && COLOR_RE.test(requested)) return requested;
  const unused = PLAYER_COLORS.find((c: string) => !usedColors.includes(c));
  return unused ?? (PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)] as string);
};
