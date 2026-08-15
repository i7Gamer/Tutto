// What the running server knows about "is anyone playing right now?", in the
// one form the operator's question needs: may I stop this process?
//
// The room registry is in-memory (rooms.ts), so only the process that holds it
// can answer — which is why this is rendered into the server's own console
// (statusLine.ts) rather than looked up at restart time, by which point the
// games it describes are already gone.
import type { Room } from './roomTypes';

/** Every count the "may I restart?" decision rests on. Categories are disjoint. */
export interface ActivitySnapshot {
  /** Rooms that exist at all, whatever state they are in. */
  rooms: number;
  /** Games actually being played: status 'playing' and not yet finished. */
  activeGames: number;
  /** Finished games whose global statistics the host has not submitted yet. */
  awaitingStats: number;
  /** Rooms still gathering players. */
  lobbies: number;
  /** Still-connected players across every room, lobbies included. */
  connectedPlayers: number;
}

export const ACTIVITY_LOG_PREFIX = '[activity]';
export const VERDICT_SAFE = 'safe to restart';
export const VERDICT_UNSAFE = 'DO NOT RESTART';

const PART_SEPARATOR = ' · ';

export const summarizeActivity = (rooms: Record<string, Room>): ActivitySnapshot => {
  const snapshot: ActivitySnapshot = {
    rooms: 0,
    activeGames: 0,
    awaitingStats: 0,
    lobbies: 0,
    connectedPlayers: 0,
  };

  for (const room of Object.values(rooms)) {
    snapshot.rooms += 1;
    snapshot.connectedPlayers += room.state.players.filter(p => !p.disconnected).length;

    // One category per room, so the counts never overlap and a leftover room
    // can be derived by subtraction. A finished game keeps status 'playing'
    // (see socketGameStateHandlers), so `finished` decides before the status
    // does — and unsubmitted statistics outrank the lobby a room may be back
    // in, because they are the thing a restart actually destroys.
    if (room.state.status === 'playing' && !room.state.finished) {
      snapshot.activeGames += 1;
    } else if (room.state.finished && !room.statsRecordedForGame.global) {
      snapshot.awaitingStats += 1;
    } else if (room.state.status === 'lobby') {
      snapshot.lobbies += 1;
    }
  }

  return snapshot;
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * The snapshot as one console line.
 *
 * Deliberately free of clocks, elapsed times and anything else that changes on
 * its own: the status line repaints only when this string differs from the one
 * before it, which is what keeps an idle server at exactly one printed line.
 */
export const renderActivityLine = (snapshot: ActivitySnapshot): string => {
  const { rooms, activeGames, awaitingStats, lobbies, connectedPlayers } = snapshot;
  const parts: string[] = [];

  if (activeGames > 0) parts.push(`${plural(activeGames, 'game')} in progress`);
  if (awaitingStats > 0) parts.push(`${awaitingStats} finished ${awaitingStats === 1 ? 'game' : 'games'} awaiting stats`);
  if (lobbies > 0) parts.push(`${plural(lobbies, 'lobby', 'lobbies')} waiting`);

  // Whatever is left is a finished game whose statistics are already in — its
  // end screen is still on someone's phone, so it gets named rather than
  // rounded down to "idle".
  const idleRooms = rooms - activeGames - awaitingStats - lobbies;
  if (idleRooms > 0) parts.push(`${plural(idleRooms, 'idle room', 'idle rooms')}`);

  if (connectedPlayers > 0) parts.push(plural(connectedPlayers, 'player'));
  if (parts.length === 0) parts.push('idle');

  const verdict = activeGames > 0 || awaitingStats > 0 ? VERDICT_UNSAFE : VERDICT_SAFE;
  return `${ACTIVITY_LOG_PREFIX} ${parts.join(PART_SEPARATOR)} — ${verdict}`;
};
