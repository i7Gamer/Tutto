import type { Server, Socket } from 'socket.io';
import { buildDeck, getLeaders, noUndoableTurn } from '../src/utils/coreGameEngine';
import { getEffectiveTurnDuration } from '../src/utils/turnDuration';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
  DEFAULT_RULESET,
} from '../src/utils/configValidation';
import { MS_PER_SECOND } from '../src/utils/time';
import { MAX_ROUNDS } from './pushValidation';
import { envLimitOr } from './envLimits';
import { updateDeviceStats } from './database';
import { statsModeFor, type Room, type RoomState, type ServerPlayer, type TurnTimerState } from './roomTypes';

// Null-prototype, not `{}`: every key here is a client-supplied roomId, and
// joinRoom validates it only as a non-empty string within a length bound. On a
// plain object literal an id naming an Object.prototype member ('__proto__',
// 'constructor', 'toString', …) reads back as the INHERITED value, so
// `!rooms[roomId]` says the room exists, nothing is created, and the handler
// then works with Object.prototype. Object.create(null) makes every key an own
// property, which is what every `rooms[id]` / `delete rooms[id]` /
// `Object.keys(rooms)` call site already assumes.
export const rooms: Record<string, Room> = Object.create(null) as Record<string, Room>;

/**
 * The Socket.IO channel a room broadcasts on — never the bare roomId.
 *
 * socket.io auto-joins every socket to a room named its own id (`this.join
 * (this.id)` in Socket._onconnect), so Socket.IO room names and socket ids are
 * ONE namespace. joinRoom validates roomId only as a 1-100 char string, and
 * sanitizePlayerForBroadcast strips only deviceId — so `players[].socketId`
 * rides every gameState and any co-member can read a victim's id. Broadcasting
 * on the bare id then lets that member join a "room" named after the victim's
 * socket from a second connection and have every io.to(...) send for it
 * delivered straight into the victim's client, which applies a gameState
 * wholesale (GAME_STATE_SYNC_KEYS in src/store/socketSlice.ts): foreign roster,
 * status, currentPlayerIndex, and an isHost flip. The reverse collision is the
 * same bug from the other side — io.to(someSocketId).emit('kicked') would reach
 * every member of a room that happens to be named that id.
 *
 * The prefix cannot occur in a socket id (socket.io ids are base64url — no
 * colon), so one helper on both sides keeps the namespaces disjoint by
 * construction. Only the wire channel is prefixed: the `rooms` map key, every
 * `session.roomId`, and every client-facing payload stay the bare roomId.
 */
export const roomChannel = (roomId: string): string => `room:${roomId}`;

// Upper bound on distinct players a single room can hold. Without one, a
// hostile or buggy client could keep joining new deviceIds into one room
// forever, growing its player/chart arrays (and every broadcast of them)
// without limit — this is a sanity cap on room size, not a real gameplay
// scenario (nobody plays Tutto with anywhere near this many players).
export const MAX_PLAYERS_PER_ROOM = 100;

// Upper bound on concurrently existing rooms. joinRoom refuses to CREATE a
// room past this cap (joins and reconnects into existing rooms are
// unaffected). Without it, a scripted client cycling join → hard-disconnect
// leaves ghost rooms alive for up to reconnectTimeout seconds each, growing
// `rooms` — and the O(rooms) one-device-one-room scan every join pays —
// without bound. Far above any realistic concurrent-game count.
export const MAX_ROOMS = 500;

// Upper bound on rooms one client address may hold open at once.
//
// MAX_ROOMS bounds the total but said nothing about how many of those 500 a
// single client could take. The one-room-per-device rule in joinRoom is no
// help: deviceId is chosen by the client, so a scripted one just picks a fresh
// value per room. Create a room with reconnectTimeout at its 3600s maximum
// (joinRoom applies the joiner's initialConfig to the room it has just
// created), hard-disconnect, and the seat's reconnect timer holds the room for
// an hour — isAbandonedRoom refuses to free a room with a pending timer, and
// nothing sweeps. At the connection limiter's ~3/s that is every slot on the
// server in under three minutes, and every real player gets `server_full`
// until the timers drain.
//
// Deliberately generous: a whole office or school behind one NAT may run
// several concurrent games, and a deployment behind a reverse proxy that has
// not declared TRUST_PROXY=1 sees every client as the proxy's address. Env
// tunable for both of those, and for the test suites, whose rooms all arrive
// from 127.0.0.1 (see vite.config.ts test.env and playwright.config.ts).
export const MAX_ROOMS_PER_ADDRESS = 20;

const envMaxRoomsPerAddress = (): number =>
  envLimitOr(process.env.MAX_ROOMS_PER_ADDRESS, MAX_ROOMS_PER_ADDRESS);

/**
 * How many live rooms this address created.
 *
 * Counted off `rooms` on demand, for the same reason the one-room-per-device
 * check is: a separate tally would have to be decremented on every path that
 * removes a room (deleteRoom, the abandonment checks, a draining reconnect
 * timer), and the one that got missed would leak the cap shut. An empty
 * address is "not attributed" — a room seeded directly by a test — and counts
 * for nobody.
 */
export const countRoomsCreatedBy = (address: string): number =>
  address === '' ? 0 : Object.values(rooms).filter(r => r.createdBy === address).length;

export const isAtRoomAddressCap = (address: string): boolean =>
  countRoomsCreatedBy(address) >= envMaxRoomsPerAddress();

/**
 * "No turn seen yet" for the pushState turn-change tracking.
 *
 * The four fields are one answer to "which turn have we already scheduled a
 * deadline for", so they reset together: a leftover lastDeckSize or
 * restartsThisTurn would make the next pushState misjudge a fresh turn. Five
 * sites across three modules reset this, and each used to spell out all four
 * assignments.
 */
export const idleTurnTimerState = (): TurnTimerState => ({
  lastCard: null,
  lastPlayerIndex: null,
  lastDeckSize: null,
  restartsThisTurn: 0,
});

/**
 * Marks the room's CURRENT turn as the one already seen, so the next pushState
 * doesn't read it as new and hand out a fresh deadline. Call after the state
 * fields it reads (currentCard, currentPlayerIndex, cards) are settled.
 */
export const rememberCurrentTurn = (room: Room): void => {
  room.turnTimerState = {
    lastCard: room.state.currentCard,
    lastPlayerIndex: room.state.currentPlayerIndex,
    lastDeckSize: room.state.cards.length,
    restartsThisTurn: 0,
  };
};

// createdBy is the client address that created the room, for the per-address
// cap above. Defaults to '' — "not attributed" — so a room seeded directly by
// a test counts against nobody.
export const createRoom = (hostSocketId: string, createdBy = ''): Room => ({
  host: hostSocketId,
  createdBy,
  // The first broadcast this room makes is version 1 (emitRoomState bumps
  // before it sends), so nothing a client can apply ever carries 0.
  stateVersion: 0,
  gameActualStartTime: null,
  turnTimerState: null,
  // Null-prototype for the same reason `rooms` is: the keys are client-supplied
  // deviceIds. `timers['__proto__'] = setTimeout(...)` on a plain object hits
  // the prototype setter — the timer becomes the object's prototype, invisible
  // to the Object.keys/values that cancel it, so deleteRoom cannot stop it.
  disconnectTimers: Object.create(null) as Room['disconnectTimers'],
  turnExpireTimer: null,
  statsRecordedForGame: { devices: new Set(), global: false },
  // Matches the default config below. Recomputed the moment a game actually
  // starts, so this only covers a room that somehow submits without one.
  normalizedGame: true,
  ruleset: DEFAULT_RULESET,
  finishedGame: null,
  startRoster: null,
  state: {
    players: [],
    status: 'lobby',
    initialCards: { ...DEFAULT_INITIAL_CARDS },
    winningScore: DEFAULT_WINNING_SCORE,
    randomOrder: true,
    turnDuration: DEFAULT_TURN_DURATION,
    reconnectTimeout: DEFAULT_RECONNECT_TIMEOUT,
    currentCard: null,
    cards: [],
    round: 1,
    currentPlayerIndex: null,
    finished: false,
    chartValues: [],
    chartNames: [],
    chartLabels: [],
    gameTimeInSeconds: 0,
    turnStartTime: null,
    ...noUndoableTurn(),
    liveTurnState: null,
    enforcedDiceMode: null,
    ruleset: DEFAULT_RULESET,
    historyLog: [],
  },
});

// Every room-deletion site must go through this, not a bare `delete rooms[id]`.
// A pending disconnect-timeout timer (armed in socketHandlers.handlePlayerLeave)
// captures roomId in its closure and looks the room up fresh, by id, when it
// fires — so if the room was deleted without cancelling it, and a NEW room is
// later created under the same id (e.g. the disconnected player reconnects and
// recreates it), the stale timer fires against that unrelated new room and can
// evict a player from it, or delete it outright.
export const deleteRoom = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  if (room.turnExpireTimer) clearTimeout(room.turnExpireTimer);
  Object.values(room.disconnectTimers).forEach(timer => clearTimeout(timer));
  delete rooms[roomId];
};

/**
 * A room nothing can ever free again: every remaining seat is disconnected and
 * no reconnect timer is pending to remove any of them (reconnectTimeout=0 arms
 * none). No socket left to disconnect, no timer left to fire, and a host id
 * pointing at a dead socket — it would survive until the process restarts, and
 * spend one of MAX_ROOMS for good.
 *
 * Checked wherever a seat is given up, because a room can ENTER this state on
 * any of those paths: the last connected player leaving, being kicked, or a
 * draining reconnect timer taking the last TIMED seat and leaving timerless
 * ghosts behind it. Callers pair it with an explicit empty-roster check, which
 * still holds even if a stale timer were somehow left in the map.
 */
export const isAbandonedRoom = (room: Room): boolean =>
  room.state.players.every(p => p.disconnected) &&
  Object.keys(room.disconnectTimers).length === 0;

export const drawNextCardForRoom = (state: RoomState): void => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift() ?? null;
  } else {
    const deck = buildDeck(state.initialCards);
    state.currentCard = deck.shift() ?? null;
    state.cards = deck;
  }
};

export const handleActivePlayerRemoved = (room: Room, removedIdx: number): void => {
  const state = room.state;
  // chartValues/chartNames are player-indexed (one entry per player), so the
  // removed player's slot is spliced out of both. chartLabels is NOT spliced
  // here — it's round-indexed (one entry per completed round, shared across
  // all players), so a player leaving never removes an entry from it.
  if (Array.isArray(state.chartValues) && removedIdx < state.chartValues.length) {
    state.chartValues.splice(removedIdx, 1);
  }
  if (Array.isArray(state.chartNames) && removedIdx < state.chartNames.length) {
    state.chartNames.splice(removedIdx, 1);
  }

  if (state.currentPlayerIndex === null) return;
  const curIdx = state.currentPlayerIndex;
  if (removedIdx < curIdx) {
    state.currentPlayerIndex = curIdx - 1;
  } else if (removedIdx === curIdx) {
    // `state.players` has already been spliced by the caller, so its length here
    // is the original turn-order size minus one. The removed player was the last
    // to act this round only if their index equals that post-splice length —
    // otherwise players after them still owe a turn this round, and jumping the
    // round forward would skip those turns entirely.
    const removedPlayerWasLastInOrder = removedIdx === state.players.length;
    state.currentPlayerIndex = curIdx % Math.max(1, state.players.length);
    Object.assign(state, noUndoableTurn());
    // The removed player was mid-turn — drop their live dice snapshot so
    // spectators don't keep seeing it attributed to the player now in this slot.
    state.liveTurnState = null;
    let isGameOver = false;
    if (removedPlayerWasLastInOrder) {
      // Same bookkeeping calculateNextTurn does on a normal round end (see
      // gameSlice.nextTurn / advanceTurnOnTimeout) — without it, the round this
      // removal forces past never gets a chart data point, and the end-screen
      // score-per-round chart silently comes up one round short.
      // Capped like advanceTurnOnTimeout's twin append, and for a sharper
      // reason than unbounded growth: MAX_ROUNDS is what pushValidation
      // ENFORCES on an incoming chartLabels, refusing a longer one wholesale.
      // A server array grown past the bound is one no client can ever push
      // back, so the server's copy and every client's would diverge from the
      // first append past it onward.
      if (state.chartValues.length === state.players.length && state.chartNames.length === state.players.length
          && state.chartLabels.length < MAX_ROUNDS) {
        state.chartValues.forEach((vals, i) => vals.push(state.players[i].score));
        state.chartLabels.push(state.round);
      }
      // Same win check calculateNextTurn runs at the same round boundary —
      // without it, a removal that forces the round past a sole leader who
      // already reached winningScore hands out a whole extra round instead of
      // ending the game there (during which e.g. a Plus/Minus could even flip
      // the winner).
      const leaders = getLeaders(state.players);
      isGameOver = leaders.length === 1 && leaders[0].score >= state.winningScore;
      if (!isGameOver) state.round += 1;
    }
    if (isGameOver) {
      state.finished = true;
      state.currentPlayerIndex = null;
      state.currentCard = null;
      state.turnStartTime = null;
      if (room.gameActualStartTime) {
        state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / MS_PER_SECOND);
        room.gameActualStartTime = null;
      }
    } else {
      state.turnStartTime = Date.now();
      drawNextCardForRoom(state);
    }
  }

  // Keep pushState's turn-change tracking in step with the adjusted index/card.
  // Without this, the next pushState compares against the pre-removal values,
  // misreads the shifted index (or freshly changed deck) as a brand-new turn,
  // and resets turnStartTime again — granting the active player extra time.
  rememberCurrentTurn(room);
};

/**
 * Hands the room to a connected player when the socket that just died was the
 * one holding it, and reports whether it did.
 *
 * A room whose host id is a dead socket is unmanageable: `pushState`'s host
 * branch, `updateConfig`, `kickPlayer` and `submitGlobalStats` all gate on
 * `room.host === socket.id`, so nobody can change config, kick the ghost,
 * restart, or record the game. Both places a host can vanish need this — the
 * reconnect-timeout timer and, because a disabled kick timer arms no timer at
 * all, the disconnect itself.
 *
 * players[0] is the fallback rather than the preference: it may itself be
 * disconnected, which is the very state this exists to get out of.
 */
export const promoteHostAfterLoss = (room: Room, lostSocketId: string): boolean => {
  if (room.host !== lostSocketId) return false;
  const nextHost = room.state.players.find(p => !p.disconnected) ?? room.state.players[0];
  if (!nextHost) return false;
  room.host = nextHost.socketId;
  return true;
};

export const calculateGameTime = (room: Room): number => {
  if (!room.gameActualStartTime || room.state.status !== 'playing') {
    return room.state.gameTimeInSeconds;
  }
  return Math.floor((Date.now() - room.gameActualStartTime) / MS_PER_SECOND);
};

export const calculateRemainingTurnTime = (room: Room): number | null => {
  if (!room.state.turnStartTime || room.state.turnDuration === 0) return null;

  const targetDuration = getEffectiveTurnDuration(room.state.currentCard, room.state.turnDuration);
  const elapsedSeconds = Math.floor((Date.now() - room.state.turnStartTime) / MS_PER_SECOND);
  return Math.max(0, targetDuration - elapsedSeconds);
};

// deviceId is a reconnect credential (see joinRoom: possession of a player's
// deviceId is enough to take over their seat), so it must never be broadcast
// to other room members — only the owning client's own outgoing joinRoom call
// carries it. previousLeaders is a snapshot of full player objects and needs
// the same scrubbing.
export const sanitizePlayerForBroadcast = (p: ServerPlayer): Omit<ServerPlayer, 'deviceId'> => {
  const rest: Partial<ServerPlayer> = { ...p };
  delete rest.deviceId;
  return rest as Omit<ServerPlayer, 'deviceId'>;
};

/**
 * Writes a played, lost game for every game-start seat that is no longer at
 * the table by the time the game's verdict is frozen — a seat that left, was
 * kicked, or timed out BEFORE the finish was ever broadcast, and so never ran
 * its own endGameStats submission (that handler requires a currently seated
 * socket; see socketStatsHandlers.ts). Left unrecorded, that device's win
 * streak and win rate are silently frozen at whatever they were before this
 * game, and it can never earn a fastest-loss record either — permanent,
 * silent damage.
 *
 * Called once, right after rememberFinishedGame freezes room.finishedGame for
 * the first time — the same "verdict is now final" moment endGameStats itself
 * trusts. room.startRoster is the only record of who was actually there at
 * kickoff; without it (a room whose game predates this feature, or one seeded
 * directly by a test) there is nothing to compare against, so nothing is
 * written — the pre-existing, survivors-only behavior.
 *
 * Shares statsRecordedForGame.devices with endGameStats — the exact same
 * per-game dedup — so a later submission for the same device+game (a rejoin
 * whose client still thinks it owes its own endGameStats) is a no-op, and a
 * write already in flight here blocks that submission just as one already
 * committed there blocks a duplicate of this one.
 *
 * No per-turn counters (not cheaply available once the seat is gone — its
 * ServerPlayer object was already spliced out) and no records: the seat never
 * saw the game through to the end, so `wins`/`gamesPlayed` are the only fields
 * set, `wins: 0` also resetting the device's current win streak.
 */
const recordDepartedSeatsStats = (room: Room): void => {
  if (!room.startRoster || !room.finishedGame) return;
  const seatedDeviceIds = new Set(room.state.players.map(p => p.deviceId));
  const mode = statsModeFor(room);
  const { playerCount } = room.finishedGame;

  for (const { deviceId } of room.startRoster) {
    if (!deviceId || seatedDeviceIds.has(deviceId)) continue;
    if (room.statsRecordedForGame.devices.has(deviceId)) continue;
    // Marked BEFORE the write for the same reason endGameStats marks its own
    // dedup before awaiting: this loop runs synchronously start to finish, so
    // without it a start-roster listing the same deviceId twice (impossible
    // from a real join, but nothing here depends on that) would race its own
    // two iterations into two writes.
    room.statsRecordedForGame.devices.add(deviceId);
    updateDeviceStats(deviceId, {
      gamesPlayed: 1,
      wins: 0,
      totalPlayersSum: playerCount,
      mostPlayersInGame: playerCount,
    }, mode).catch((err: unknown) => {
      // Reopened on failure so a retry (the same trigger firing again, or the
      // device's own later reconnect) can still record the game — mirrors
      // endGameStats' write-failure rollback.
      room.statsRecordedForGame.devices.delete(deviceId);
      console.error('[recordDepartedSeatsStats] error:', err);
    });
  }
};

/**
 * Freezes who won, the first moment the room reports the game over.
 *
 * Called from emitRoomState because that is the one place EVERY path to
 * `finished` passes through on its way out — the winning pushState, the turn
 * timer's game-over, and an active player's removal all broadcast, and none of
 * them can reach a client without doing so. Freezing at each of those three
 * sites instead would work until the fourth one was added without it.
 *
 * Idempotent — checked explicitly rather than via `??=` so recordDepartedSeatsStats
 * runs exactly once, on the transition into a frozen verdict, rather than on
 * every later broadcast of the same finished game (a seat leaving, the end
 * screen's traffic). Self-clearing, so the next game starts with no verdict
 * rather than the previous one's.
 */
const rememberFinishedGame = (room: Room): void => {
  if (!room.state.finished) {
    room.finishedGame = null;
    return;
  }
  if (room.finishedGame) return;
  room.finishedGame = {
    winners: getLeaders(room.state.players).map(p => p.name),
    playerCount: room.startRoster?.length ?? room.state.players.length,
  };
  recordDepartedSeatsStats(room);
};

/**
 * The `gameState` payload: the whole room state with the deviceId-bearing
 * player objects scrubbed, the two clock fields recomputed against now, and
 * the room's current stateVersion.
 *
 * stateVersion is the client's ordering floor (see Room.stateVersion), so this
 * builder deliberately does NOT bump it — emitRoomState does, exactly once per
 * broadcast, which is what makes "one bump = one accepted mutation reaching
 * the room" true no matter which of its dozen callers fired. A reply that
 * merely re-sends what a client already has (emitRoomStateTo) re-uses the
 * current version instead, so it is applied rather than dropped as stale.
 */
const buildGameStatePayload = (room: Room) => ({
  ...room.state,
  players: room.state.players.map(sanitizePlayerForBroadcast),
  previousLeaders: room.state.previousLeaders
    ? room.state.previousLeaders.map(sanitizePlayerForBroadcast)
    : room.state.previousLeaders,
  turnTimeRemaining: calculateRemainingTurnTime(room),
  gameTimeInSeconds: calculateGameTime(room),
  stateVersion: room.stateVersion,
});

export const emitRoomState = (io: Server, roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  rememberFinishedGame(room);
  room.stateVersion += 1;
  io.to(roomChannel(roomId)).emit('gameState', buildGameStatePayload(room));
  io.to(roomChannel(roomId)).emit('hostId', room.host);
};

/**
 * The same snapshot, to one socket only and without advancing the version —
 * nothing changed, this is a re-read. Used by the `requestState` handler, which
 * a client falls back to when its own push was refused and it can no longer
 * trust what it is rendering.
 */
export const emitRoomStateTo = (socket: Socket, roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  socket.emit('gameState', buildGameStatePayload(room));
  socket.emit('hostId', room.host);
};
