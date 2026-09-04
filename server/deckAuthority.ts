import { buildDeck } from '../src/utils/coreGameEngine';
import { drawNextCardForRoom, recordDealtCard } from './rooms';
import { MAX_DECK_SIZE } from './pushValidation';
import type { CardType, DiceSnapshot, TurnSummary } from '../src/types';
import type { Room, RoomState } from './roomTypes';

/**
 * The room's deck, and who deals from it.
 *
 * `cards` is the ordered list of cards NOT YET DEALT, and the whole
 * push-your-luck decision in the classic rule set is "bank what you are
 * holding, or reveal the next card and risk it". A client that can WRITE that
 * list picks its own next card; a client that can merely read it already knows
 * the answer before it decides. This module is the first half of the fix: the
 * server becomes the only thing that ever moves the deck, so the card a player
 * gets is chosen after they have committed to drawing.
 *
 * (The second half — no longer broadcasting `cards` at all — is deliberately
 * NOT here. Every client still receives the deck exactly as before, so a
 * client that predates this change keeps working across the redeploy that
 * ships it. Until that second half lands the leak is still open; what this
 * buys is that closing it needs no further change to the draw path.)
 *
 * Three server paths already dealt without asking a client — the turn timer's
 * expiry (turnTimers.advanceTurnOnTimeout), the active player being removed
 * (rooms.handleActivePlayerRemoved), and a mid-turn chain draw's own socket
 * event. This module covers the fourth and last one: the deck move implied by
 * a pushState that has just been merged.
 */

/**
 * The deck-relevant state as it stood BEFORE a push was merged.
 *
 * Every judgment below is a comparison between two moments, and
 * applyPushedState mutates the room in place — so the "before" side has to be
 * read off first. The turn-record fields around the deck are all writable by a
 * push, which is why the judgments below lean on the two that are not:
 * `currentCard` (server-owned, so "the room was holding a card" is the
 * server's own account of a turn being in play) and `currentPlayerIndex` as
 * the room held it before the push moved it.
 */
export interface DeckContext {
  currentCard: CardType | null;
  currentPlayerIndex: number | null;
  previousCard: CardType | null;
  previousPlayerName: string | null;
  previousTurnSummary: TurnSummary | null;
  liveTurnState: DiceSnapshot | null;
}

export const readDeckContext = (state: RoomState): DeckContext => ({
  currentCard: state.currentCard,
  currentPlayerIndex: state.currentPlayerIndex,
  previousCard: state.previousCard,
  previousPlayerName: state.previousPlayerName,
  previousTurnSummary: state.previousTurnSummary,
  liveTurnState: state.liveTurnState,
});

/**
 * What a merged push did to the deck.
 *
 *  - 'kickoff'  — a game began: build a deck and deal its first card.
 *  - 'advance'  — the turn was handed on: deal the next seat its card.
 *  - 'undo'     — the turn was handed back: re-deal it and return what it took.
 *  - 'teardown' — the room is back in the lobby: there is no deck to hold.
 *  - 'hold'     — anything else, which is nearly every push.
 */
export type DeckMove = 'kickoff' | 'advance' | 'undo' | 'teardown' | 'hold';

/**
 * The seat before / after `from` in roster order, or -1 when there is no seat
 * to speak of.
 *
 * Turn order is strictly roster order and nothing skips: calculateNextTurn
 * takes `currentPlayerIndex + 1` and wraps to 0 on a new round, and
 * calculateUndo hands the turn to `currentPlayerIndex - 1` (wrapping to the
 * last seat on a round-end undo). So both moves are decidable from the seat
 * the room was ALREADY on — a number the server holds — with no reference to
 * previousPlayerName, which rides in on the very push being judged.
 */
const seatBefore = (state: RoomState, from: number | null): number =>
  from === null || state.players.length === 0
    ? -1
    : (from - 1 + state.players.length) % state.players.length;

const seatAfter = (state: RoomState, from: number | null): number =>
  from === null || state.players.length === 0
    ? -1
    : (from + 1) % state.players.length;

/**
 * Whether the push handed the turn BACK to the seat that just played it.
 *
 * calculateUndo's own two moves, and both are required: the turn goes to the
 * seat before the one that was playing, and the whole previous-turn record is
 * cleared in the same snapshot (noUndoableTurn). Neither half alone is enough
 * — an ordinary advance also moves the index, and a push that merely clears
 * previousCard moves the turn nowhere.
 *
 * pushValidation's `looksLikeUndo` recognises the same push for a different
 * purpose (which seat's stats the pusher may write) and anchors on the
 * PUSHER's predecessor, where this anchors on the predecessor of the seat the
 * room was on. They coincide on every honest undo, since the seat playing is
 * the one that undoes. The difference is deliberate: each is anchored to what
 * its own decision is about, and both anchors are server-held — the point
 * being that neither reads previousPlayerName, which is what used to let
 * either be aimed at a seat the turn had never been at.
 *
 * At exactly two seats the predecessor and the successor are the same seat, so
 * the index move alone cannot say which of the two happened and the pushed
 * previousCard breaks the tie — checked before isAdvanceMove below, so the tie
 * goes to the undo. That is what an honest client means by clearing the field,
 * and claiming it grants nothing: the active seat may undo the turn behind it
 * outright anyway.
 */
const isUndoMove = (state: RoomState, before: DeckContext): boolean =>
  before.previousCard !== null &&
  state.previousCard === null &&
  state.currentPlayerIndex === seatBefore(state, before.currentPlayerIndex);

/**
 * Whether the push handed the turn ON, having actually played one.
 *
 * The moved index is NOT the whole signal, and taking it as such was the first
 * version of this: `currentPlayerIndex` is a field any accepted push carries,
 * so a stale client re-pushing an index the room had already moved past burned
 * a card off the deck for a turn nobody played. A real advance moves the turn
 * to the seat AFTER the one the room was on, which is a fact about the room
 * rather than about the push.
 *
 * The discriminator used to be previousPlayerName instead — but that field
 * arrives in the same push it is meant to vouch for, so naming any seat but
 * the one that was playing turned an ordinary advance into a 'hold' and the
 * next player was forced onto the card already in play, chosen after reading
 * the broadcast deck. Same reason the undo test above no longer reads it.
 *
 * The MERGED previousCard was the next version of exactly that mistake, and it
 * is what `before.currentCard` replaces: previousCard is written by the push
 * (applyPreviousCard takes null as readily as a card), so pushing
 * `previousCard: null` beside an honest hand-over withheld the deal all over
 * again — 'hold' at three seats or more, and at two seats 'undo', which rewound
 * the deck for a turn nobody undid. "A turn was in play" is a fact about the
 * room: the room was holding a card, and currentCard is server-owned
 * (SERVER_OWNED_FIELD_LIST) and dealt only here.
 *
 * The room's own previousCard is NOT the anchor to use, tempting as it looks:
 * it is null for the whole first turn of every game, so the first hand-over
 * would deal nothing.
 */
const isAdvanceMove = (state: RoomState, before: DeckContext): boolean =>
  before.currentPlayerIndex !== null &&
  before.currentCard !== null &&
  state.currentPlayerIndex === seatAfter(state, before.currentPlayerIndex);

export const classifyDeckMove = (state: RoomState, before: DeckContext, startedGame: boolean): DeckMove => {
  if (startedGame) return 'kickoff';
  if (state.status !== 'playing') return 'teardown';
  // A finished game keeps the card it ended on: that is what the end screen
  // names, and it is exactly what the winning push leaves behind today.
  if (state.finished) return 'hold';
  if (state.currentPlayerIndex === null) return 'hold';
  if (state.currentPlayerIndex === before.currentPlayerIndex) return 'hold';
  if (isUndoMove(state, before)) return 'undo';
  if (isAdvanceMove(state, before)) return 'advance';
  return 'hold';
};

/**
 * Puts back what an undone turn took off the deck, and re-deals it.
 *
 * The same reconstruction calculateUndo does client-side (its `newDeck` /
 * `drawnCard`), computed here from the server's own pre-push record instead of
 * being taken on trust from the pushed one — which is the whole point: the
 * client's `cards` and `currentCard` are ignored now, so if the server did not
 * rebuild the deck itself an undo would silently deal a fresh card and lose
 * the undone turn's chain from the deck for good.
 *
 * Reconstructed from the server's own deal log (Room.dealtLastTurn /
 * dealtThisTurn), never from the push. It used to read previousTurnSummary and
 * liveTurnState, which are PUSHABLE — so both WHICH cards came back and which
 * one became `currentCard` were the client's to name, and repeating
 * plant-a-summary-then-undo let a player prepend an arbitrary run of chosen
 * cards. The MAX_DECK_SIZE cap that stood in for a fix bounded how many, never
 * which; it is kept below only as a backstop on a log that cannot exceed
 * MAX_CHAIN_CARDS per turn anyway.
 *
 * `dealtLastTurn[0]` is the card the undone turn opened on and becomes current
 * again; the rest of that turn's draws, then the card this turn opened on, go
 * back on top in the order they will be re-dealt — which is exactly what
 * calculateUndo computes client-side, so the two decks stay identical.
 */
const restoreDeckForUndo = (room: Room): void => {
  const state = room.state;
  const undone = room.dealtLastTurn;
  // No record of a previous turn means no undo. An honest one always has one:
  // the advance that ended that turn wrote it, and the first turn of a game
  // has nothing behind it to give back (calculateUndo refuses there too). So
  // this is only reachable by a push that claims an undo the room never saw —
  // and falling back to the pushed previousCard would hand it a card it named,
  // since applyPreviousCard accepts any valid card without checking the room
  // was holding it. Deal nothing and move nothing; the broadcast that follows
  // puts the caller back on the server's view.
  if (undone.length === 0) return;

  state.cards = [...undone.slice(1), ...room.dealtThisTurn, ...state.cards].slice(0, MAX_DECK_SIZE);
  state.currentCard = undone[0];

  // The undone turn is about to be replayed from its opening card, so the log
  // now describes THAT turn and there is no undoable turn behind it — which is
  // also what the push itself asserts by clearing previousCard.
  room.dealtThisTurn = [undone[0]];
  room.dealtLastTurn = [];
};

/**
 * Performs the deck move a merged push implies, and reports which one it was.
 *
 * Called from the pushState handler after applyPushedState and BEFORE the
 * turn-timer bookkeeping, so a dealt card is part of the same broadcast as the
 * turn it belongs to — a second broadcast would leave every client rendering
 * the previous card for a round trip.
 */
export const settleDeck = (room: Room, before: DeckContext, startedGame: boolean): DeckMove => {
  const state = room.state;
  const move = classifyDeckMove(state, before, startedGame);
  switch (move) {
    case 'kickoff': {
      // The host used to push the deck it had built itself, which made the
      // opening order the host's to choose. buildDeck runs here instead.
      const deck = buildDeck(state.initialCards);
      state.currentCard = deck.shift() ?? null;
      state.cards = deck;
      // A new game starts the log over: nothing before this card belongs to a
      // turn that could still be undone.
      room.dealtLastTurn = [];
      room.dealtThisTurn = [];
      recordDealtCard(room, state.currentCard, true);
      break;
    }
    case 'advance':
      drawNextCardForRoom(state);
      recordDealtCard(room, state.currentCard, true);
      break;
    case 'undo':
      restoreDeckForUndo(room);
      break;
    case 'teardown':
      // What endGame's own push used to carry (`status: 'lobby'` alongside
      // `cards: []` and `currentCard: null`) and can no longer write itself.
      state.cards = [];
      state.currentCard = null;
      room.dealtThisTurn = [];
      room.dealtLastTurn = [];
      break;
    case 'hold':
      break;
  }
  return move;
};
