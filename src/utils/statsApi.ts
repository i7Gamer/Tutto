import { isNormalizedConfig, DEFAULT_RULESET, type NormalizableConfig } from './configValidation';
import { DEFAULT_GAME_MODE, type GameMode, type Ruleset } from '../types';

// Where this device's statistics for one mode live. Written out once because
// three screens read it — the statistics page, the end screen and the
// pre-game record snapshot — and each of them means a specific bucket.
//
// The mode is always stated rather than left to the server's default, so a URL
// says which numbers it is asking for.
export const deviceStatsUrl = (deviceId: string, mode: GameMode = DEFAULT_GAME_MODE): string =>
  `/api/stats/${encodeURIComponent(deviceId)}?mode=${mode}`;

// Which bucket a game played on this config belongs in: the ruleset picks the
// pair, normalized-vs-custom picks within it. Display-only: the server
// decides what is actually recorded, from the config it froze when the game
// started. For an honest client the two always agree.
export const gameModeOf = (config: NormalizableConfig, ruleset: Ruleset = DEFAULT_RULESET): GameMode => {
  const normalized = isNormalizedConfig(config);
  if (ruleset === 'classic') return normalized ? 'classic' : 'classic_custom';
  return normalized ? 'normalized' : 'custom';
};

// The buckets that never move the main records — shared so every "is this a
// custom game?" decision (record celebrations, notices) means the same thing.
export const isCustomGameMode = (mode: GameMode): boolean =>
  mode === 'custom' || mode === 'classic_custom';
