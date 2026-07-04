import type { Server } from 'socket.io';
import type { CoreGameState } from '../src/types';
import { calculateNextTurn } from '../src/utils/coreGameEngine';
import type { Room, ServerPlayer } from './roomTypes';
import { rooms, calculateRemainingTurnTime, emitRoomState } from './rooms';

export const clearServerTurnTimer = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room || !room.turnExpireTimer) return;
  clearTimeout(room.turnExpireTimer);
  room.turnExpireTimer = null;
};

// The server is the sole authority on turn expiry: no client (host or otherwise)
// advances the turn on timeout anymore. This runs even if every player has
// disconnected, so a dead host tab or a backgrounded/throttled client tab can
// never stall the game for everyone else.
export const advanceTurnOnTimeout = (io: Server, roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  room.turnExpireTimer = null;

  if (room.state.finished || room.state.status !== 'playing' || room.state.currentPlayerIndex === null) {
    return;
  }

  try {
    const currentPlayerIndex = room.state.currentPlayerIndex;

    // calculateNextTurn only reads players/currentPlayerIndex/currentCard/round/
    // winningScore/cards/initialCards — the remaining CoreGameState fields are
    // unused by it but required by the type, so they're filled with inert values.
    const stateForCalc = {
      players: room.state.players,
      currentPlayerIndex,
      currentCard: room.state.currentCard,
      round: room.state.round,
      winningScore: room.state.winningScore,
      cards: room.state.cards,
      initialCards: room.state.initialCards,
      previousCard: room.state.previousCard,
      previousScore: room.state.previousScore,
      previousLeaders: room.state.previousLeaders,
      previousWasBust: room.state.previousWasBust ?? false,
      previousHighestTurnScore: room.state.previousHighestTurnScore ?? 0,
      finished: room.state.finished,
      gameStartTime: null,
      gameTimeInSeconds: room.state.gameTimeInSeconds,
    };

    // Timeout = the player neither scored nor answered in time, same as a manual
    // "Stop & Score 0" — matches what the client used to send on host-side expiry.
    const result = calculateNextTurn(
      stateForCalc as unknown as CoreGameState & { currentPlayerIndex: number },
      0,
      false,
    );

    room.state.players = result.players as ServerPlayer[];
    room.state.previousCard = result.previousCard;
    room.state.previousScore = result.previousScore;
    room.state.previousLeaders = result.previousLeaders as ServerPlayer[] | null;
    room.state.previousWasBust = result.previousWasBust;
    room.state.previousHighestTurnScore = result.previousHighestTurnScore;
    room.state.previousPlayerName = result.previousPlayerName;
    room.state.liveTurnState = null;

    if (result.isRoundEnd) {
      room.state.chartValues.forEach((vals, i) => vals.push(result.players[i]?.score ?? 0));
      room.state.chartLabels.push(room.state.round);
    }

    if (!room.turnTimerState) {
      room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
    }

    if (result.isGameOver) {
      room.state.finished = true;
      room.state.currentPlayerIndex = null;
      room.state.currentCard = null;
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
        room.gameActualStartTime = null;
      }
      room.turnTimerState.lastCard = null;
      room.turnTimerState.lastPlayerIndex = null;
    } else {
      room.state.currentPlayerIndex = result.nextIndex;
      room.state.round = result.nextRound;
      room.state.cards = result.newDeck;
      room.state.currentCard = result.drawnCard;
      room.state.turnStartTime = Date.now();
      // Mark this as the "already seen" turn so the next pushState's cardChanged/
      // playerChanged check doesn't treat it as a fresh turn and reschedule again.
      room.turnTimerState.lastCard = result.drawnCard;
      room.turnTimerState.lastPlayerIndex = result.nextIndex;
      startServerTurnTimer(io, roomId);
    }

    emitRoomState(io, roomId);
  } catch (err) {
    // Backstop: pushState's own validation should make a malformed room state
    // unreachable, but this callback runs on a bare setTimeout with no caller to
    // catch a throw — an uncaught exception here would crash the whole process
    // (every room, every player), not just this one room's turn.
    console.error(`[turnTimer] Failed to advance turn for room ${roomId}:`, err);
  }
};

// Schedules (or reschedules) the server-side expiry for the room's current turn,
// based on room.state.turnStartTime and the authoritative remaining-time formula
// (calculateRemainingTurnTime) — the same value clients are shown. Safe to call
// repeatedly: it always clears any existing timer first, so config changes or
// player-removal events mid-turn can simply call this again to resync.
export const startServerTurnTimer = (io: Server, roomId: string): void => {
  clearServerTurnTimer(roomId);
  const room = rooms[roomId];
  if (!room) return;
  if (room.state.status !== 'playing' || room.state.finished || room.state.currentPlayerIndex === null) return;
  if (!room.state.turnDuration || !room.state.turnStartTime) return;

  const remainingSeconds = calculateRemainingTurnTime(room);
  if (remainingSeconds === null) return;

  if (remainingSeconds <= 0) {
    // Duration was shortened below the already-elapsed time (e.g. host lowered
    // turnDuration mid-turn) — the turn is already over, advance immediately.
    advanceTurnOnTimeout(io, roomId);
    return;
  }

  room.turnExpireTimer = setTimeout(() => advanceTurnOnTimeout(io, roomId), remainingSeconds * 1000);
};

export const abortGameIfLowPlayers = (io: Server, room: Room, roomId: string): boolean => {
  // A finished game stays status 'playing' (with finished=true) all the way
  // through the end screen — see pushState's startingGame comment — so without
  // the finished check, the last remaining player leaving/kicking a peer from
  // there would silently wipe their end screen (finished reset to false) and
  // show a misleading "game aborted" toast for a game that already ended normally.
  if (room.state.status === 'playing' && !room.state.finished && room.state.players.length < 2) {
    clearServerTurnTimer(roomId);
    io.to(roomId).emit('gameAborted');
    room.state.status = 'lobby';
    room.state.currentCard = null;
    room.state.currentPlayerIndex = null;
    room.state.finished = false;
    room.state.turnStartTime = null;
    // Without this, the aborted game's elapsed time (plus however long the room
    // then sits idle in the lobby) bleeds into the next game's clock and stats,
    // since gameActualStartTime is only otherwise reset when a client pushes a
    // lobby/finished state — which never happens on a server-initiated abort.
    room.gameActualStartTime = null;
    if (room.turnTimerState) {
      room.turnTimerState.lastCard = null;
      room.turnTimerState.lastPlayerIndex = null;
    }
    return true;
  }
  return false;
};
