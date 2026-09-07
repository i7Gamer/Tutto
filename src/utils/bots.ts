import { BOT_PERSONALITIES, type BotPersonality, type Player } from '../types';

/**
 * Who sits down when a bot is added. Fixed rather than localised: the names
 * work in both languages, and a name that changed with the UI language would
 * break every name-keyed lookup mid-game (Plus/Minus deduction, undo, the
 * history log). Reserved: the store refuses a human under a seated bot's
 * name and a bot under a seated human's — the same case-insensitive rule the
 * roster already enforces for two humans.
 */
export const BOT_NAMES: Readonly<Record<BotPersonality, string>> = {
  cautious: 'Carl',
  risky: 'Rita',
  optimal: 'Otto',
};

export const isBotPersonality = (value: unknown): value is BotPersonality =>
  typeof value === 'string' && (BOT_PERSONALITIES as readonly string[]).includes(value);

/**
 * The seat's personality, or null for a human. A save is free text as far as
 * the validator is concerned, so a corrupt value reads as "not a bot" rather
 * than driving a turn with a strategy that does not exist.
 */
export const botOf = (player: Pick<Player, 'bot'> | null | undefined): BotPersonality | null =>
  player && isBotPersonality(player.bot) ? player.bot : null;
