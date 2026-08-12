import { isNormalizedConfig, DEFAULT_RULESET, type NormalizableConfig } from './configValidation';
import { DEFAULT_GAME_MODE, type GameMode, type Ruleset } from '../types';

// Where this device's statistics live — one fixed path for every device. The
// id rides a header instead of a path segment because a path segment is
// written into every fronting proxy's access.log, and this id is what lets a
// client reclaim its seat: anyone who can read those logs would hold it.
export const DEVICE_STATS_PATH = '/api/stats/device';
export const DEVICE_ID_HEADER = 'x-tutto-device';

// The whole request rather than just the URL, because three screens read it —
// the statistics page, the end screen and the pre-game record snapshot — and
// handing back the two halves together is what stops one of them from
// fetching the path and forgetting the header (which the server answers with
// a 400, having no id to look up).
//
// The id is percent-encoded: it reaches this call straight from localStorage,
// and a header value may only carry visible ASCII — an id holding a newline
// would make fetch reject the request outright, and an unescaped one could
// otherwise smuggle a second header. server/api.ts decodes it back before it
// reaches the database, so what is stored stays byte-identical to what the
// socket path writes.
//
// The mode is always stated rather than left to the server's default, so a
// request says which numbers it is asking for.
export const deviceStatsRequest = (
  deviceId: string,
  mode: GameMode = DEFAULT_GAME_MODE,
): [string, RequestInit] => [
  `${DEVICE_STATS_PATH}?mode=${mode}`,
  { headers: { [DEVICE_ID_HEADER]: encodeURIComponent(deviceId) } },
];

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
