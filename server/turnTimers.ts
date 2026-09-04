import type { Server } from 'socket.io';
import { MAX_HISTORY_LOG_SIZE, type CoreGameState, type TurnSummary } from '../src/types';
import { TOTAL_DICE } from '../src/utils/turnShapes';
import { calculateNextTurn } from '../src/utils/coreGameEngine';
import { isBust } from '../src/utils/diceLogic';
import { hasScoreInput } from '../src/utils/diceTurnControls';
import { roomPhase } from '../src/utils/roomPhase';
import type { Room, ServerPlayer } from './roomTypes';
import { rooms, calculateRemainingTurnTime, emitRoomState, idleTurnTimerState, recordDealtCard, rememberCurrentTurn, roomChannel } from './rooms';
import { MAX_ROUNDS } from './pushValidation';
import { clearDeck } from './deckAuthority';
import { MS_PER_SECOND } from '../src/utils/time';

// Milliseconds for a server timer armed from a duration in seconds — the turn
// expiry below and socketRoomHandlers' seat reconnect timer both arm through
// this. TEST_TIMER_SCALE (set by vite.config.ts for the suite and by
// socketTestHarness.ts for spawned servers) compresses the wait so tests can
// drive expiries without real-time sleeps. It is test infrastructure, not an
// operator knob: production ignores it outright, so a stray value following a
// deployer's shell into a real server cannot shrink every reconnect window
// 5x. Junk values (non-numeric, zero, negative) run unscaled rather than
// NaN-arming the timer or flooring every wait to 10ms, the same guard
// SOCKET_CONN_LIMIT_MAX gets in socketHandlers.ts. The 10ms floor keeps a
// heavily scaled short timer from firing effectively synchronously
// (MIN_SCALED_TIMER_MS).
const MIN_SCALED_TIMER_MS = 10;

export const scaledTimerMs = (
  seconds: number,
  env: { NODE_ENV?: string; TEST_TIMER_SCALE?: string } = process.env,
): number => {
  const parsed = Number(env.TEST_TIMER_SCALE);
  const scale = env.NODE_ENV !== 'production' && Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return Math.max(MIN_SCALED_TIMER_MS, Math.floor(seconds * MS_PER_SECOND * scale));
};

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

  if (roomPhase(room.state) !== 'playing' || room.state.currentPlayerIndex === null) {
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
      //    'timeout' without marking the last card completed;
      //  - an empty table, neither busted nor stopped = the drawn-card
      //    reveal (or the reload window it restores into): the new card is
      //    in the chain but its first roll never happened, so like the
      //    stopped case it forfeits as 'timeout' with the last card
      //    uncompleted — DiceGame's restore.midDraw reads this same
      //    snapshot as "resume by rolling", not as a bust. A drawn Stop
      //    parks here too, and stays the Stop forfeit via the `ended`
      //    ternary below.
      // Counted across BOTH lists, because six dice aside is what a completed
      // card looks like in EITHER of the two shapes the client emits:
      //  - the choice still OPEN: DiceGame offers it on
      //    `keptDice.length + selectedRolls.length === TOTAL_DICE`, so the
      //    completing dice are still `selected` inside currentRoll and
      //    buildDiceSnapshot copies the two lists separately. Reading keptDice
      //    alone never matched this window at all, and charged an AFK player a
      //    bust for a card they had completed;
      //  - the decision already BANKED (Finish / a modernized turn-ending
      //    tutto / the Kleeblatt win): those paths move all six into keptDice,
      //    empty currentRoll and set `stopped` together. `stopped` must NOT
      //    disqualify them — it only says the decision was made, not that the
      //    tutto was not, and stoppedBanked below decides `ended`, never the
      //    per-card completion flag.
      // A Stop & Score without a tutto also sets `stopped`, but banks fewer
      // than six, so the count alone still tells the two apart.
      const asideCount = snapshot.keptDice.length
        + snapshot.currentRoll.filter(d => d.selected).length;
      const atBankChoice = !snapshot.busted && asideCount === TOTAL_DICE;
      // A snapshot taken while the dice were still tumbling carries no verdict:
      // `busted` is written by finalizeRoll once every die has settled, while
      // the live snapshot is debounced from the moment the roll starts. Trusting
      // that unwritten flag charged a classic Feuerwerk whose null was still in
      // the air as a forfeiting dice null, while a reload of the very same
      // snapshot banked it — DiceGame's restore re-derives the verdict from the
      // dice (diceTurnRestore.ts's rollBusts) instead. Re-derive it here with
      // the same shared predicate so both authorities answer alike.
      const rollBusts = !snapshot.busted && !snapshot.stopped
        && (snapshot.rollingDiceIds?.length ?? 0) > 0 && snapshot.currentRoll.length > 0
        && isBust(snapshot.currentRoll.map(d => d.val), lastCard, snapshot.kniffelProgress, room.state.ruleset);
      const feuerwerkBanked = (!!snapshot.busted || rollBusts) && lastCard === 'Feuerwerk' && snapshot.turnScore > 0;
      const stoppedBanked = !snapshot.busted && !!snapshot.stopped;
      const atDrawWindow = !snapshot.busted && !snapshot.stopped
        && snapshot.keptDice.length === 0 && snapshot.currentRoll.length === 0;
      // The physical branch of the same question. With no dice in the
      // snapshot neither asideCount nor `busted` can answer it, so a classic
      // physical turn says so outright (see DiceSnapshot.lastCardCompleted).
      const lastCompleted = atBankChoice || feuerwerkBanked || !!snapshot.lastCardCompleted;
      timeoutSummary = {
        // Every card before the last was completed (the chain only continues
        // on a completion).
        cards: chainCards.map((card, i) => ({ card, completed: i < chainCards.length - 1 || lastCompleted })),
        tuttoCount: snapshot.chainTuttoCount ?? 0,
        plusMinusScores: snapshot.plusMinusScores ?? [],
        // A timeout during the drawn-Stop summary window is still that Stop's
        // forfeit; a completed last card — or a banked Stop & Score decision —
        // ends as 'timeout' (forfeit without a bust); only a genuinely
        // unresolved roll counts the dice null.
        ended: lastCard === 'Stop' ? 'stopCard' : (lastCompleted || stoppedBanked || atDrawWindow) ? 'timeout' : 'null',
        ...(snapshot.turnScore > 0 ? { forfeitedScore: snapshot.turnScore } : {}),
      };
    }

    // A modernized turn carries no chain fields, so it never reaches the
    // reconstruction above — but `stopped` says the same thing the chain's
    // stoppedBanked case does: the decision was made and banked (Stop & Score,
    // or a turn-ending tutto) and only the summary's auto-continue never
    // fired. The points are forfeited like any timeout, yet no dice null was
    // ever rolled, so this must not be charged a bust either.
    //
    // isSuccess is the only input that drives that bust in the engine's
    // modernized path — and only for a card whose turn ends on a score.
    // Claiming it for a Yes/No card would instead read as that card COMPLETED,
    // paying out its fixed value (and handing a Kleeblatt the game outright),
    // for no gain: a special card is exempt from the bust to begin with.
    const decidedBeforeTimeout = !timeoutSummary && !!snapshot?.stopped && !snapshot.busted &&
      hasScoreInput(room.state.currentCard);

    // Timeout = the player neither scored nor answered in time, same as a manual
    // "Stop & Score 0" — matches what the client used to send on host-side expiry.
    // isTimeout: true unconditionally — every commit from here is the
    // server's clock forcing the turn, never a player action. It only
    // actually changes the logged HistoryEventType for the modernized
    // decided-before-timeout case (see calculateNextTurn); every other path
    // (a real bust, a Stop skip, a classic chain's own `ended`) is unaffected.
    const result = calculateNextTurn(
      stateForCalc as CoreGameState & { currentPlayerIndex: number },
      0,
      decidedBeforeTimeout,
      timeoutSummary,
      true,
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
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / MS_PER_SECOND);
        room.gameActualStartTime = null;
      }
      room.turnTimerState = idleTurnTimerState();
    } else {
      room.state.currentPlayerIndex = result.nextIndex;
      room.state.round = result.nextRound;
      room.state.cards = result.newDeck;
      room.state.currentCard = result.drawnCard;
      recordDealtCard(room, result.drawnCard, true);
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
  if (roomPhase(room.state) !== 'playing' || room.state.currentPlayerIndex === null) return;
  if (!room.state.turnDuration || !room.state.turnStartTime) return;

  const remainingSeconds = calculateRemainingTurnTime(room);
  if (remainingSeconds === null) return;

  if (remainingSeconds <= 0) {
    // Duration was shortened below the already-elapsed time (e.g. host lowered
    // turnDuration mid-turn) — the turn is already over, advance immediately.
    advanceTurnOnTimeout(io, roomId);
    return;
  }

  const timeoutMs = scaledTimerMs(remainingSeconds);
  room.turnExpireTimer = setTimeout(() => advanceTurnOnTimeout(io, roomId), timeoutMs);
};

export const abortGameIfLowPlayers = (io: Server, room: Room, roomId: string): boolean => {
  // roomPhase, not status alone — a finished game reads as status 'playing'
  // all the way through the end screen (see roomPhase), so without excluding
  // it here, the last remaining player leaving/kicking a peer from there
  // would silently wipe their end screen (finished reset to false) and show a
  // misleading "game aborted" toast for a game that already ended normally.
  if (roomPhase(room.state) === 'playing' && room.state.players.length < 2) {
    clearServerTurnTimer(roomId);
    io.to(roomChannel(roomId)).emit('gameAborted');
    room.state.status = 'lobby';
    // The deck, the card in play and the deal log, cleared exactly as a push
    // back to the lobby clears them — see clearDeck. Only currentCard was
    // reset here, so the aborted game's undrawn deck rode the lobby broadcast.
    clearDeck(room);
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
