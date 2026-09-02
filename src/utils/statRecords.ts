import type { DeviceStatsRow, GlobalStatsRow } from '../types';

// This device (tied-for-)holds the record when its value matches the global
// max/min exactly — only meaningful once both sides have real data. A tie
// counts: that is what "holding" a record means, whether the field is a MAX
// (highestTurnScore) or a MIN (fastestWinTurns) — the personal and global
// sides are always on the same footing (both someone's best, one of them
// this device's), so equality reads the same way regardless of direction.
export const isRecordHolder = (personal?: number | null, global?: number | null): boolean =>
  !!(personal && global && personal > 0 && global > 0 && personal === global);

// Every stat a personal value can hold the global record on, in one place
// instead of a `holdsRecord(...) && <RecordBadge />` repeated at each tile in
// Statistics.tsx — that duplication is exactly how mostPlayersInGame and
// highestForfeitedTurnScore went without a badge while every other entry
// here had one: nothing forced a new tile to remember it.
//
// Lives outside Statistics.tsx (rather than exported from it) only because a
// component file may export components alone — react-refresh/
// only-export-components. Statistics.test.tsx imports this same array so its
// table-driven coverage cannot drift from what the component renders either.
export const RECORD_FIELDS = [
  'highestTurnScore', 'fastestWinTurns', 'fastestLossTurns', 'mostPlayersInGame',
  'longestGameRounds', 'mostCardsInTurn', 'highestForfeitedTurnScore',
  'highestFeuerwerkTurnScore', 'highestX2TurnScore',
] as const satisfies readonly (keyof DeviceStatsRow & keyof GlobalStatsRow)[];

export type RecordField = typeof RECORD_FIELDS[number];
