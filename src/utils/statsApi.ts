import { isNormalizedConfig, type NormalizableConfig } from './configValidation';
import { DEFAULT_GAME_MODE, type GameMode } from '../types';

// Where this device's statistics for one mode live. Written out once because
// three screens read it — the statistics page, the end screen and the
// pre-game record snapshot — and each of them means a specific bucket.
//
// The mode is always stated rather than left to the server's default, so a URL
// says which numbers it is asking for.
export const deviceStatsUrl = (deviceId: string, mode: GameMode = DEFAULT_GAME_MODE): string =>
  `/api/stats/${encodeURIComponent(deviceId)}?mode=${mode}`;

// Which bucket a game played on this config belongs in. Display-only: the
// server decides what is actually recorded, from the config it froze when the
// game started. For an honest client the two always agree.
export const gameModeOf = (config: NormalizableConfig): GameMode =>
  isNormalizedConfig(config) ? 'normalized' : 'custom';
