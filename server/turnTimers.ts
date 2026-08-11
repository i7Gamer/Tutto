import type { Server } from 'socket.io';
import { MAX_HISTORY_LOG_SIZE, type CoreGameState, type TurnSummary } from '../src/types';
import { calculateNextTurn } from '../src/utils/coreGameEngine';
import type { Room, ServerPlayer } from './roomTypes';
import { rooms, calculateRemainingTurnTime, emitRoomState, idleTurnTimerState, rememberCurrentTurn } from './rooms';
import { MAX_ROUNDS } from './pushValidation';

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
      previousWasBust: room.state.previousWasBust,
      previousHighestTurnScore: room.state.previousHighestTurnScore,
      previousHighestFeuerwerkTurnScore: room.state.previousHighestFeuerwerkTurnScore,
      previousHighestX2TurnScore: room.state.previousHighestX2TurnScore,
      previousTurnSummary: room.state.previousTurnSummary,
      finished: room.state.finished,
      gameStartTime: null,
      gameTimeInSeconds: room.state.gameTimeInSeconds,
      historyLog: room.state.historyLog,
    };

    // A classic chain that times out would otherwise commit through the
    // legacy path, which only knows the CURRENT card — every earlier chain
    // card's counters (and the chain records) would be lost. The live dice
    // snapshot the active player was streaming carries the whole chain, and
    // its chain fields only ever exist for classic turns, so their presence
    // also answers "was this a classic game?". Physical dice and modernized
    // games have no chain fields and keep the legacy behavior; the snapshot
    // may lag the last action by its ~300ms debounce — a floor, not a
    // problem. The reconstructed summary also lands in previousTurnSummary,
    // so undoing a timed-out chain restores the consumed cards to the deck.
    const snapshot = room.state.liveTurnState;
    let timeoutSummary: TurnSummary | undefined;
    if (snapshot?.cardsThisTurn && snapshot.cardsThisTurn.length > 0) {
      const chainCards = snapshot.cardsThisTurn;
      const lastCard = chainCards[chainCards.length - 1];
      // Where the timer caught the player decides what the last card's
      // outcome really was — the same classification DiceGame's own restore
      // applies to this snapshot:
      //  - all six dice put aside without a bust = the bank-or-draw choice
      //    (the one state an AFK player parks in, since it has no client
      //    countdown): the card was COMPLETED and no null was ever rolled;
      //  - a busted Feuerwerk with points on the table = the classic
      //    banks-on-null summary, whose manual path counts no bust either;
      //  - the stopped marker = a Stop & Score decision parked in its
      //    summary countdown: decided and banked, no null ever rolled — but
      //    the card itself was NOT completed (no tutto), so it forfeits as
      //    'timeout' without marking the last card completed.
      const atBankChoice = !snapshot.busted && snapshot.keptDice.length === 6;
      const feuerwerkBanked = !!snapshot.busted && lastCard === 'Feuerwerk' && snapshot.turnScore > 0;
      const stoppedBanked = !snapshot.busted && !!snapshot.stopped;
      const lastCompleted = atBankChoice || feuerwerkBanked;
      timeoutSummary = {
        // Every card before the last was completed (the chain only continues
        // on a completion).
        cards: chainCards.map((card, i) => ({ card, completed: i < chainCards.length - 1 || lastCompleted })),
        tuttoCount: snapshot.chainTuttoCount ?? 0,
        plusMinusSuccesses: snapshot.plusMinusSuccesses ?? 0,
        // A timeout during the drawn-Stop summary window is still that Stop's
        // forfeit; a completed last card — or a banked Stop & Score decision —
        // ends as 'timeout' (forfeit without a bust); only a genuinely
        // unresolved roll counts the dice null.
        ended: lastCard === 'Stop' ? 'stopCard' : (lastCompleted || stoppedBanked) ? 'timeout' : 'null',
        ...(snapshot.turnScore > 0 ? { forfeitedScore: snapshot.turnScore } : {}),
      };
    }

    // Timeout = the player neither scored nor answered in time, same as a manual
    // "Stop & Score 0" — matches what the client used to send on host-side expiry.
    const result = calculateNextTurn(
      stateForCalc as CoreGameState & { currentPlayerIndex: number },
      0,
      false,
      timeoutSummary,
    );

    room.state.players = result.players as ServerPlayer[];
    room.state.previousCard = result.previousCard;
    room.state.previousScore = result.previousScore;
    room.state.previousLeaders = result.previousLeaders as ServerPlayer[] | null;
    room.state.previousWasBust = result.previousWasBust;
    room.state.previousWasSuccess = result.previousWasSuccess;
    room.state.previousHighestTurnScore = result.previousHighestTurnScore;
    room.state.previousHighestFeuerwerkTurnScore = result.previousHighestFeuerwerkTurnScore;
    room.state.previousHighestX2TurnScore = result.previousHighestX2TurnScore;
    room.state.previousPlayerName = result.previousPlayerName;
    room.state.previousTurnSummary = result.previousTurnSummary;
    room.state.liveTurnState = null;

    if (!room.state.historyLog) room.state.historyLog = [];
    room.state.historyLog.push(result.historyEntry);
    if (room.state.historyLog.length > MAX_HISTORY_LOG_SIZE) {
      room.state.historyLog.shift();
    }

    // chartLabels is round-indexed and chartValues is player-indexed, so a label
    // may only be appended when the series it labels were appended too —
    // otherwise labels outgrow every series and the end-screen chart skews.
    // Guarded on chartValues alone (not chartNames, as handleActivePlayerRemoved
    // additionally does) because that is the array actually being appended to
    // here; chartNames is only a fallback label source for the chart. Capped at
    // MAX_ROUNDS like the pushed arrays: this path can self-advance for as long
    // as nobody reaches the winning score, and must not grow state unboundedly.
    if (result.isRoundEnd && room.state.chartValues.length === result.players.length
        && room.state.chartLabels.length < MAX_ROUNDS) {
      room.state.chartValues.forEach((vals, i) => vals.push(result.players[i]?.score ?? 0));
      room.state.chartLabels.push(room.state.round);
    }

    room.turnTimerState ??= idleTurnTimerState();

    if (result.isGameOver) {
      room.state.finished = true;
      room.state.currentPlayerIndex = null;
      room.state.currentCard = null;
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
        room.gameActualStartTime = null;
      }
      room.turnTimerState = idleTurnTimerState();
    } else {
      room.state.currentPlayerIndex = result.nextIndex;
      room.state.round = result.nextRound;
      room.state.cards = result.newDeck;
      room.state.currentCard = result.drawnCard;
      room.state.turnStartTime = Date.now();
      // Mark this as the "already seen" turn so the next pushState's deck/
      // player-change check doesn't treat it as a fresh turn and reschedule.
      rememberCurrentTurn(room);
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

  const timerScale = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
  const timeoutMs = Math.max(10, Math.floor(remainingSeconds * 1000 * timerScale));
  room.turnExpireTimer = setTimeout(() => advanceTurnOnTimeout(io, roomId), timeoutMs);
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
    // The aborted game's last dice snapshot must not survive into the lobby —
    // it would ride every subsequent broadcast (and the spectator panel)
    // until the next game finally overwrote it.
    room.state.liveTurnState = null;
    room.turnTimerState = idleTurnTimerState();
    return true;
  }
  return false;
};
