/**
 * @vitest-environment node
 *
 * The "is anyone playing right now?" summary behind the console status line
 * (statusLine.ts). Everything here is pure: the categories are derived from
 * room state only, so every combination that decides between "safe to restart"
 * and "DO NOT RESTART" can be pinned without a server, a socket or a timer.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeActivity,
  renderActivityLine,
  ACTIVITY_LOG_PREFIX,
  VERDICT_SAFE,
  VERDICT_UNSAFE,
  type ActivitySnapshot,
} from './activity';
import { createRoom } from './rooms';
import type { Room, ServerPlayer } from './roomTypes';

// summarizeActivity reads two fields off a player — whether it is connected,
// and its deviceId, which decides whether that player's statistics have been
// recorded yet. The fixtures carry exactly those rather than the full
// 20-field ServerPlayer shape.
let deviceSeq = 0;
const player = (disconnected: boolean): ServerPlayer =>
  ({ disconnected, deviceId: `dev-${deviceSeq += 1}` }) as ServerPlayer;

interface RoomFixture {
  status?: 'lobby' | 'playing';
  finished?: boolean;
  statsRecorded?: boolean;
  connected?: number;
  disconnected?: number;
}

const roomWith = ({
  status = 'lobby',
  finished = false,
  statsRecorded = false,
  connected = 0,
  disconnected = 0,
}: RoomFixture): Room => {
  const room = createRoom('sock-host');
  room.state.status = status;
  room.state.finished = finished;
  room.statsRecordedForGame.global = statsRecorded;
  room.state.players = [
    ...Array.from({ length: connected }, () => player(false)),
    ...Array.from({ length: disconnected }, () => player(true)),
  ];
  // "Recorded" means recorded — the global row AND every seated device's own.
  // The fixture used to set only the global flag, which is not a state the
  // server reaches: each client submits its own row on the same `finished`
  // edge the host submits the global one on.
  if (statsRecorded) {
    room.state.players.forEach(p => room.statsRecordedForGame.devices.set(p.deviceId, 'full'));
  }
  return room;
};

// Mirrors the null-prototype registry in rooms.ts.
const registry = (...entries: Room[]): Record<string, Room> => {
  const map = Object.create(null) as Record<string, Room>;
  entries.forEach((room, index) => { map[`ROOM${index}`] = room; });
  return map;
};

// Long enough that it cannot fire during the test; cleared in a finally.
const TIMER_NEVER_FIRES_MS = 60_000;

const emptySnapshot: ActivitySnapshot = {
  rooms: 0,
  activeGames: 0,
  awaitingStats: 0,
  lobbies: 0,
  connectedPlayers: 0,
};

const snapshotOf = (overrides: Partial<ActivitySnapshot>): ActivitySnapshot =>
  ({ ...emptySnapshot, ...overrides });

describe('summarizeActivity', () => {
  it('reports nothing at all for an empty registry', () => {
    expect(summarizeActivity(registry())).toEqual(emptySnapshot);
  });

  it('counts a lobby as a room to lose but not as a game', () => {
    const snapshot = summarizeActivity(registry(roomWith({ status: 'lobby', connected: 3 })));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, lobbies: 1, connectedPlayers: 3 }));
  });

  it('counts a running game as an active game', () => {
    const snapshot = summarizeActivity(registry(roomWith({ status: 'playing', connected: 4 })));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, activeGames: 1, connectedPlayers: 4 }));
  });

  // A finished game KEEPS status 'playing' (see socketGameStateHandlers), so
  // `finished` — not the status — is what tells a live game from an end screen.
  // The host submits the global row and every client submits its own on the
  // same `finished` edge, so the host's can land first. Reading only the
  // global flag dropped this room out of EVERY category — so the line said the
  // server was safe to restart while per-device rows, which a restart destroys,
  // were still in flight.
  it('still counts a finished game whose per-device statistics have not all landed', () => {
    const room = roomWith({ status: 'playing', finished: true, connected: 2 });
    room.statsRecordedForGame.global = true;
    // Only the first of the two players has submitted.
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');

    const snapshot = summarizeActivity(registry(room));

    expect(snapshot.awaitingStats).toBe(1);
    expect(snapshot.activeGames).toBe(0);
    expect(snapshot.lobbies).toBe(0);
  });

  it('counts a finished game as awaiting while only the device rows are in', () => {
    // The mirror image: the global row is the one still missing.
    const room = roomWith({ status: 'playing', finished: true, connected: 1 });
    room.state.players.forEach(p => room.statsRecordedForGame.devices.set(p.deviceId, 'full'));

    expect(summarizeActivity(registry(room)).awaitingStats).toBe(1);
  });

  it('stops waiting on a seat that has no reconnect timer and can never submit', () => {
    // reconnectTimeout: 0 is a supported lobby option, and on that path no
    // timer is armed at all -- the seat is removed only if EVERY player is
    // disconnected, which then deletes the room. So a player who closes their
    // tab on the end screen before their device row lands holds this room in
    // `awaiting` for as long as the process lives, and the operator's status
    // line reads DO NOT RESTART for a game nothing will ever finish
    // recording. The comment justified the wait as "until their reconnect
    // timer drains"; with the kick timer off, it never does.
    const room = roomWith({ status: 'playing', finished: true, connected: 1, disconnected: 1 });
    room.statsRecordedForGame.global = true;
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');

    const snapshot = summarizeActivity(registry(room));

    expect(snapshot.awaitingStats, 'nothing will ever change this room').toBe(0);
    expect(snapshot.connectedPlayers).toBe(1);
  });

  it('keeps waiting on a disconnected seat whose reconnect timer is still armed', () => {
    // The control, and the case the original comment describes: this seat is
    // still on its way out, so the room resolves on its own when the timer
    // fires and the seat is spliced. Their statistics really are pending.
    const room = roomWith({ status: 'playing', finished: true, connected: 1, disconnected: 1 });
    room.statsRecordedForGame.global = true;
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');
    const armed = setTimeout(() => {}, TIMER_NEVER_FIRES_MS);
    room.disconnectTimers[room.state.players[1].deviceId] = armed;

    try {
      expect(summarizeActivity(registry(room)).awaitingStats).toBe(1);
    } finally {
      clearTimeout(armed);
    }
  });

  it('keeps waiting on a CONNECTED seat that has not submitted, timer or not', () => {
    // The other control: "no armed timer" must not be read as "gone". A
    // connected player with no row in yet is exactly the in-flight case
    // statsFullyRecorded was widened to cover in the first place.
    const room = roomWith({ status: 'playing', finished: true, connected: 2 });
    room.statsRecordedForGame.global = true;
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');

    expect(summarizeActivity(registry(room)).awaitingStats).toBe(1);
  });

  it('keeps waiting on a connected seat whose row is still the server-written verdict', () => {
    // A seat that was disconnected at the finish gets a 'verdict-only' row
    // from the server; when that device comes back its own per-turn counters
    // are still owed and MERGE into that row. Presence in the dedup map is
    // therefore not "recorded" — only 'full' is.
    const room = roomWith({ status: 'playing', finished: true, connected: 2 });
    room.statsRecordedForGame.global = true;
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');
    room.statsRecordedForGame.devices.set(room.state.players[1].deviceId, 'verdict-only');

    expect(summarizeActivity(registry(room)).awaitingStats).toBe(1);
  });

  it('stops waiting on a gone seat that holds only the server-written verdict', () => {
    // The control: verdict-only AND nothing left that could ever complete
    // it (disconnected, no reconnect timer). Its row is as recorded as it
    // will ever be, so the room must not hold the operator hostage.
    const room = roomWith({ status: 'playing', finished: true, connected: 1, disconnected: 1 });
    room.statsRecordedForGame.global = true;
    room.statsRecordedForGame.devices.set(room.state.players[0].deviceId, 'full');
    room.statsRecordedForGame.devices.set(room.state.players[1].deviceId, 'verdict-only');

    expect(summarizeActivity(registry(room)).awaitingStats).toBe(0);
  });

  it('does not count a finished game as active once its statistics are recorded', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'playing', finished: true, statsRecorded: true, connected: 4 }),
    ));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, connectedPlayers: 4 }));
  });

  // Restarting here throws away the game's global statistics: the host client
  // submits them after the game ends, and nothing re-sends them.
  it('flags a finished game whose statistics have not been submitted yet', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'playing', finished: true, statsRecorded: false, connected: 4 }),
    ));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, awaitingStats: 1, connectedPlayers: 4 }));
  });

  // Everyone dropped, but they are inside their reconnect window and the game
  // is still theirs to come back to — reported, not silently downgraded.
  it('keeps a game with every player disconnected active, with no players connected', () => {
    const snapshot = summarizeActivity(registry(roomWith({ status: 'playing', disconnected: 4 })));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, activeGames: 1, connectedPlayers: 0 }));
  });

  it('counts only the still-connected half of a partly disconnected room', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'playing', connected: 2, disconnected: 3 }),
    ));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, activeGames: 1, connectedPlayers: 2 }));
  });

  it('counts connected players across every room, lobbies included', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'playing', connected: 4 }),
      roomWith({ status: 'lobby', connected: 2 }),
    ));

    expect(snapshot).toEqual(snapshotOf({
      rooms: 2, activeGames: 1, lobbies: 1, connectedPlayers: 6,
    }));
  });

  it('sorts a mixed registry into one category per room', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'playing', connected: 3 }),
      roomWith({ status: 'playing', connected: 2 }),
      roomWith({ status: 'playing', finished: true, connected: 1 }),
      roomWith({ status: 'playing', finished: true, statsRecorded: true, connected: 1 }),
      roomWith({ status: 'lobby', connected: 1 }),
    ));

    expect(snapshot).toEqual({
      rooms: 5, activeGames: 2, awaitingStats: 1, lobbies: 1, connectedPlayers: 8,
    });
  });

  // Nothing forbids the combination, and counting it in both categories would
  // make the totals overlap. The unsubmitted statistics are the bigger loss.
  it('files a finished lobby room under its unsubmitted statistics, not as a lobby', () => {
    const snapshot = summarizeActivity(registry(
      roomWith({ status: 'lobby', finished: true, connected: 1 }),
    ));

    expect(snapshot).toEqual(snapshotOf({ rooms: 1, awaitingStats: 1, connectedPlayers: 1 }));
  });
});

describe('renderActivityLine', () => {
  it('says the server is idle when no room exists', () => {
    expect(renderActivityLine(emptySnapshot)).toBe(`${ACTIVITY_LOG_PREFIX} idle — ${VERDICT_SAFE}`);
  });

  it('refuses a restart while a game is in progress', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 1, activeGames: 1, connectedPlayers: 4 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 1 game in progress · 4 players — ${VERDICT_UNSAFE}`);
  });

  it('pluralises games and players', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 2, activeGames: 2, connectedPlayers: 1 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 2 games in progress · 1 player — ${VERDICT_UNSAFE}`);
  });

  it('reports an active game nobody is currently connected to', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 1, activeGames: 1 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 1 game in progress — ${VERDICT_UNSAFE}`);
  });

  it('refuses a restart while statistics are unsubmitted', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 1, awaitingStats: 1, connectedPlayers: 4 }));

    expect(line).toBe(
      `${ACTIVITY_LOG_PREFIX} 1 finished game awaiting stats · 4 players — ${VERDICT_UNSAFE}`,
    );
  });

  it('allows a restart with only a lobby open, and says who is in it', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 1, lobbies: 1, connectedPlayers: 2 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 1 lobby waiting · 2 players — ${VERDICT_SAFE}`);
  });

  it('pluralises lobbies irregularly', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 2, lobbies: 2, connectedPlayers: 2 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 2 lobbies waiting · 2 players — ${VERDICT_SAFE}`);
  });

  // A room that is in none of the three categories is a finished game whose
  // statistics are in. Saying "idle" while four people sit on its end screen
  // would be true about games and misleading about people.
  it('still names a leftover room nobody is playing in', () => {
    const line = renderActivityLine(snapshotOf({ rooms: 1, connectedPlayers: 4 }));

    expect(line).toBe(`${ACTIVITY_LOG_PREFIX} 1 idle room · 4 players — ${VERDICT_SAFE}`);
  });

  it('pluralises leftover rooms', () => {
    expect(renderActivityLine(snapshotOf({ rooms: 2 })))
      .toBe(`${ACTIVITY_LOG_PREFIX} 2 idle rooms — ${VERDICT_SAFE}`);
  });

  it('lists every category at once, games first and players last', () => {
    const line = renderActivityLine({
      rooms: 5, activeGames: 2, awaitingStats: 1, lobbies: 1, connectedPlayers: 8,
    });

    expect(line).toBe(
      `${ACTIVITY_LOG_PREFIX} 2 games in progress · 1 finished game awaiting stats`
      + ` · 1 lobby waiting · 1 idle room · 8 players — ${VERDICT_UNSAFE}`,
    );
  });

  // The line is rewritten in place only while it stays the same string, so a
  // clock or an elapsed time in here would repaint on every tick forever.
  it('renders the same snapshot to the same string every time', () => {
    const snapshot = snapshotOf({ rooms: 1, activeGames: 1, connectedPlayers: 4 });

    expect(renderActivityLine(snapshot)).toBe(renderActivityLine(snapshot));
  });
});
