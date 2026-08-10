import playerColorsData from '../playerColors.json';

const { PLAYER_COLORS } = playerColorsData;

/** The only colour format a client may ask for: `#rrggbb`. */
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/i;

/**
 * The colour a joining player gets: the one they asked for if it is well
 * formed AND free, otherwise the first of the palette nobody at the table is
 * using, and failing that the request after all (or any palette entry) — a
 * room can seat more players than the palette has entries, and a duplicate
 * colour beats no colour.
 *
 * A request that collides is declined because the palette walk exists to keep
 * players visually apart, and the request here is a preference restored from
 * the joiner's own storage rather than a deliberate act. Changing colour in
 * the lobby IS one, and that path (updatePlayerColor) stays free to collide.
 */
export const assignPlayerColor = (requested: unknown, usedColors: string[]): string => {
  const asked = typeof requested === 'string' && COLOR_RE.test(requested) ? requested : null;
  const taken = new Set(usedColors.map(c => c.toLowerCase()));
  if (asked && !taken.has(asked.toLowerCase())) return asked;
  const unused = PLAYER_COLORS.find((c: string) => !taken.has(c.toLowerCase()));
  return unused ?? asked ?? (PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)] as string);
};
