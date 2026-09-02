/** @vitest-environment node */
/**
 * Guards item B1 (one home for every cap/threshold): a handful of length caps
 * and gameplay thresholds used to be repeated as bare literals beside a named
 * constant that already existed for the same rule. Each check below reads the
 * real source file and fails if the old duplicate literal is still there —
 * not merely that a constant with the right name exists somewhere.
 *
 * Deliberately whole-file regex checks, in the style of bundleSplit.test.ts:
 * these are structural assertions about source text, not behavior, and the
 * files under test have no shared runtime surface to import instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relPath: string): string => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

describe('length caps share one constant instead of a duplicated literal', () => {
  it('socketRoomHandlers.joinRoom validates against the shared constants, not bare numbers', () => {
    const src = read('server/socketRoomHandlers.ts');
    expect(src).not.toMatch(/roomId\.length > 100/);
    expect(src).not.toMatch(/deviceId\.length > 200/);
    expect(src).not.toMatch(/name\.length > 30/);
    expect(src).toMatch(/roomId\.length > MAX_ROOM_ID_LENGTH/);
    expect(src).toMatch(/deviceId\.length > MAX_DEVICE_ID_LENGTH/);
    expect(src).toMatch(/name\.length > MAX_PLAYER_NAME_LENGTH/);
    expect(src).toMatch(/from ['"]\.\.\/src\/utils\/configValidation['"]/);
  });

  it('configValidation exports MAX_DEVICE_ID_LENGTH beside the other two length caps', () => {
    const src = read('src/utils/configValidation.ts');
    expect(src).toMatch(/export const MAX_DEVICE_ID_LENGTH = 200;/);
  });

  it('pushValidation imports MAX_PLAYER_NAME_LENGTH instead of redeclaring it', () => {
    const src = read('server/pushValidation.ts');
    expect(src).not.toMatch(/const MAX_PLAYER_NAME_LENGTH = 30;/);
    expect(src).toMatch(/isValidWinningScore|MAX_PLAYER_NAME_LENGTH/); // sanity: file still imports from configValidation
    expect(src).toMatch(/import\s*\{[^}]*MAX_PLAYER_NAME_LENGTH[^}]*\}\s*from\s*['"]\.\.\/src\/utils\/configValidation['"]/s);
  });

  it('pushValidation names the history-entry id cap instead of a bare 100', () => {
    const src = read('server/pushValidation.ts');
    expect(src).not.toMatch(/entry\.id\.length <= 100/);
    expect(src).toMatch(/MAX_HISTORY_ID_LENGTH\s*=\s*100/);
    expect(src).toMatch(/entry\.id\.length <= MAX_HISTORY_ID_LENGTH/);
  });

  it('pushValidation reuses MAX_CHAIN_CARDS for the history-entry deductedPlayers cap', () => {
    const src = read('server/pushValidation.ts');
    expect(src).not.toMatch(/entry\.deductedPlayers\.length > 100/);
    expect(src).toMatch(/entry\.deductedPlayers\.length > MAX_CHAIN_CARDS/);
  });

  it('api.ts imports MAX_DEVICE_ID_LENGTH instead of redeclaring it', () => {
    const src = read('server/api.ts');
    expect(src).not.toMatch(/const MAX_DEVICE_ID_LENGTH = 200;/);
    expect(src).toMatch(/import\s*\{[^}]*MAX_DEVICE_ID_LENGTH[^}]*\}\s*from\s*['"]\.\.\/src\/utils\/configValidation['"]/s);
  });
});

describe('gameplay thresholds share one constant instead of a duplicated literal', () => {
  it('Scoreboard reads the turn-urgency threshold from uiTimings, not a bare 10', () => {
    const src = read('src/components/game/Scoreboard.tsx');
    expect(src).not.toMatch(/turnTimeRemaining <= 10\b/);
    expect(src).toMatch(/turnTimeRemaining <= TURN_URGENT_SECONDS/);
    expect(src).toMatch(/import\s*\{[^}]*TURN_URGENT_SECONDS[^}]*\}\s*from\s*['"]\.\.\/\.\.\/utils\/uiTimings['"]/s);
  });

  it('Game.tsx gates the urgency haptic off the named threshold', () => {
    const src = read('src/components/Game.tsx');
    expect(src).not.toMatch(/turnTimeRemaining <= 10\)/);
    expect(src).toMatch(/turnTimeRemaining <= TURN_URGENT_SECONDS\)/);
  });

  it('Leaderboard shows the streak badge off HOT_WIN_STREAK (the badge moved there from Game.tsx)', () => {
    const src = read('src/components/game/Leaderboard.tsx');
    expect(src).not.toMatch(/streak >= 3\b/);
    expect(src).toMatch(/streak >= HOT_WIN_STREAK/);
  });

  it('LobbyShared shows the win-streak badge off the same HOT_WIN_STREAK constant', () => {
    const src = read('src/components/home/LobbyShared.tsx');
    expect(src).not.toMatch(/streak >= 3\b/);
    expect(src).toMatch(/streak >= HOT_WIN_STREAK/);
    expect(src).toMatch(/import\s*\{[^}]*HOT_WIN_STREAK[^}]*\}\s*from\s*['"]\.\.\/\.\.\/utils\/playerStats['"]/s);
  });

  it('HOT_WIN_STREAK lives in playerStats.ts, not redeclared in Statistics.tsx', () => {
    const stats = read('src/components/Statistics.tsx');
    expect(stats).not.toMatch(/const HOT_WIN_STREAK = 3;/);
    const playerStats = read('src/utils/playerStats.ts');
    expect(playerStats).toMatch(/export const HOT_WIN_STREAK = 3;/);
  });

  it('BlurInput default maxVal reuses MAX_WINNING_SCORE instead of a bare 99999', () => {
    const src = read('src/components/home/LobbyShared.tsx');
    expect(src).not.toMatch(/maxVal = 99999/);
    expect(src).toMatch(/maxVal = MAX_WINNING_SCORE/);
  });

  it('GameControls names the quick-add score list instead of an inline array literal', () => {
    const src = read('src/components/game/GameControls.tsx');
    expect(src).not.toMatch(/\[50, 100, 200, 300, 400, 500, 600, 1000\]\.map/);
    expect(src).toMatch(/QUICK_ADD_SCORES\.map/);
    expect(src).toMatch(/const QUICK_ADD_SCORES/);
  });

  it('cancelReconnect names its failsafe timeout instead of a bare 10000', () => {
    const src = read('src/store/socketSlice.ts');
    expect(src).not.toMatch(/setTimeout\(cleanup, 10000\)/);
    expect(src).toMatch(/setTimeout\(cleanup, CANCEL_RECONNECT_FAILSAFE_MS\)/);
    expect(src).toMatch(/import\s*\{[^}]*CANCEL_RECONNECT_FAILSAFE_MS[^}]*\}\s*from\s*['"]\.\.\/utils\/uiTimings['"]/s);
  });
});

describe('MS_PER_SECOND has one home in src/utils/time.ts', () => {
  it('time.ts exports the constant', () => {
    const src = read('src/utils/time.ts');
    expect(src).toMatch(/export const MS_PER_SECOND = 1000;/);
  });

  it('store/timers.ts imports it instead of declaring its own copy', () => {
    const src = read('src/store/timers.ts');
    expect(src).not.toMatch(/export const MS_PER_SECOND = 1000;/);
    expect(src).toMatch(/import\s*\{\s*MS_PER_SECOND\s*\}\s*from\s*['"]\.\.\/utils\/time['"]/);
  });

  const clientMsPerSecondSites: [string, RegExp][] = [
    ['src/store/gameSlice.ts', /Date\.now\(\) - state\.gameStartTime\) \/ 1000\)/],
    ['src/store/persistence.ts', /gameTimeInSeconds \|\| 0\) \* 1000/],
    ['src/hooks/useAutoContinueCountdown.ts', /setTimeout\(\(\) => setCountdown\(prev => \(prev !== null \? prev - 1 : prev\)\), 1000\)/],
  ];

  it.each(clientMsPerSecondSites)('%s no longer spells out the bare ms-per-second literal', (file, bareLiteral) => {
    const src = read(file);
    expect(src).not.toMatch(bareLiteral);
    expect(src).toMatch(/MS_PER_SECOND/);
    expect(src).toMatch(/from ['"].*utils\/time['"]/);
  });

  const serverMsPerSecondSites: [string, RegExp][] = [
    ['server/rooms.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/socketGameStateHandlers.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/turnTimers.ts', /gameActualStartTime\) \/ 1000\)/],
    ['server/rateLimit.ts', /existing\.resetAt - now\) \/ 1000\)/],
  ];

  it('scaledTimerMs names both the ms-per-second factor and its floor', () => {
    const src = read('server/turnTimers.ts');
    expect(src).not.toMatch(/seconds \* 1000/);
    expect(src).not.toMatch(/Math\.max\(10,/);
    expect(src).toMatch(/MIN_SCALED_TIMER_MS/);
  });

  it.each(serverMsPerSecondSites)('%s no longer spells out the bare ms-per-second literal', (file, bareLiteral) => {
    const src = read(file);
    expect(src).not.toMatch(bareLiteral);
    expect(src).toMatch(/MS_PER_SECOND/);
    expect(src).toMatch(/from ['"]\.\.\/src\/utils\/time['"]/);
  });
});
