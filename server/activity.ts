// What the running server knows about "is anyone playing right now?", in the
// one form the operator's question needs: may I stop this process?
//
// The room registry is in-memory (rooms.ts), so only the process that holds it
// can answer — which is why this is rendered into the server's own console
// (statusLine.ts) rather than looked up at restart time, by which point the
// games it describes are already gone.
import { roomPhase } from '../src/utils/roomPhase';
import type { Room, ServerPlayer } from './roomTypes';

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

/**
 * Whether a finished game has been recorded in full.
 *
 * Both halves, not just the global one. Every client submits its OWN device row
 * on the `finished` edge, and the host submits the global row on that same edge
 * — so the host's can land first and leave a slower client's still in flight.
 * Reading `global` alone then dropped the room out of every category, and the
 * line reported the server safe to restart while per-device rows were exactly
 * what a restart would destroy.
 *
 * A seated player who never returns no longer holds this, even though the
 * predicate below still says they could submit: the server writes that seat's
 * row itself the moment the verdict is frozen (recordDepartedSeatsStats in
 * rooms.ts now treats a DISCONNECTED seat as departed). That row is only
 * 'verdict-only', though — the seat's per-turn counters are still owed, and a
 * device that does come back MERGES them into it and marks it 'full'. So the
 * check beside this asks for 'full', not mere presence in the dedup map, and
 * this predicate decides whether anyone is left to complete the row: a seat
 * still connected, or one whose reconnect timer has not yet drained.
 *
 * Unless there is no timer to drain. reconnectTimeout: 0 is a supported lobby
 * option and arms nothing at all — on that path a seat is removed only if
 * EVERY player is disconnected, which deletes the room outright. So a player
 * who closes their tab on the end screen before their device row lands used to
 * hold the room in `awaiting` for the life of the process, and the status line
 * read DO NOT RESTART for a game nothing would ever finish recording. Such a
 * seat is not pending, it is gone.
 */
const canStillSubmit = (room: Room, player: ServerPlayer): boolean =>
  !player.disconnected || player.deviceId in room.disconnectTimers;

const statsFullyRecorded = (room: Room): boolean =>
  room.statsRecordedForGame.global
  && room.state.players.every(p =>
    room.statsRecordedForGame.devices.get(p.deviceId) === 'full' || !canStillSubmit(room, p));

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
    // can be derived by subtraction. roomPhase already puts 'finished' ahead
    // of 'lobby'/'playing' for exactly this reason — and unsubmitted
    // statistics outrank the lobby a room may be back in, because they are
    // the thing a restart actually destroys.
    const phase = roomPhase(room.state);
    if (phase === 'playing') {
      snapshot.activeGames += 1;
    } else if (phase === 'finished' && !statsFullyRecorded(room)) {
      snapshot.awaitingStats += 1;
    } else if (phase === 'lobby') {
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
