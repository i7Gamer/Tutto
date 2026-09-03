import { buildDeck, inProgressChainCards } from '../src/utils/coreGameEngine';
import { drawNextCardForRoom } from './rooms';
import { MAX_DECK_SIZE } from './pushValidation';
import type { CardType, DiceSnapshot, TurnSummary } from '../src/types';
import type { RoomState } from './roomTypes';

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
 * read off first. `currentCard`/`cards` are no longer writable by a push at
 * all, but the four turn-record fields around them are, and they are exactly
 * what says which move the push made.
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
 * Whether the push handed the turn BACK to the seat that just played it.
 *
 * calculateUndo's own two moves, and both are required: the turn goes to the
 * seat named by previousPlayerName, and the whole previous-turn record is
 * cleared in the same snapshot (noUndoableTurn). Neither half alone is enough
 * — an ordinary advance also moves the index, and a push that merely clears
 * previousCard moves the turn nowhere.
 */
const isUndoMove = (state: RoomState, before: DeckContext): boolean =>
  before.previousCard !== null &&
  state.previousCard === null &&
  before.previousPlayerName !== null &&
  state.currentPlayerIndex === state.players.findIndex(p => p.name === before.previousPlayerName);

/**
 * Whether the push handed the turn ON, having actually played one.
 *
 * The moved index is NOT the whole signal, and taking it as such was the first
 * version of this: `currentPlayerIndex` is a field any accepted push carries,
 * so a stale client re-pushing an index the room had already moved past burned
 * a card off the deck for a turn nobody played. A real advance (calculateNextTurn)
 * always names the seat it took the turn from in previousPlayerName, and that
 * seat is the one that WAS playing.
 */
const isAdvanceMove = (state: RoomState, before: DeckContext): boolean =>
  before.currentPlayerIndex !== null &&
  state.previousCard !== null &&
  state.previousPlayerName !== null &&
  state.players[before.currentPlayerIndex]?.name === state.previousPlayerName;

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
 * Capped at MAX_DECK_SIZE because the cards it gives back are ultimately
 * CLIENT-chosen: previousTurnSummary and liveTurnState are both pushable
 * fields. Each is bounded at MAX_CHAIN_CARDS where it enters pushValidation,
 * which bounds one undo — but nothing bounded the accumulation across repeated
 * push-a-summary-then-undo cycles, and a deck grown past MAX_DECK_SIZE is also
 * one no honest client could ever have produced. The tail is what gets
 * dropped, never the cards being restored, so a legitimate undo is unaffected.
 */
const restoreDeckForUndo = (state: RoomState, before: DeckContext): void => {
  const chainCards = before.previousTurnSummary?.cards.map(c => c.card) ?? [];
  const hasChain = chainCards.length > 0;
  // ...and the turn being discarded gives back everything IT drew, not just
  // the card in play (see inProgressChainCards).
  const liveCards = inProgressChainCards(before.currentCard, before.liveTurnState);

  state.cards = (hasChain
    ? [...chainCards.slice(1), ...liveCards, ...state.cards]
    : [...liveCards, ...state.cards]
  ).slice(0, MAX_DECK_SIZE);
  state.currentCard = hasChain ? chainCards[0] : before.previousCard;
};

/**
 * Performs the deck move a merged push implies, and reports which one it was.
 *
 * Called from the pushState handler after applyPushedState and BEFORE the
 * turn-timer bookkeeping, so a dealt card is part of the same broadcast as the
 * turn it belongs to — a second broadcast would leave every client rendering
 * the previous card for a round trip.
 */
export const settleDeck = (state: RoomState, before: DeckContext, startedGame: boolean): DeckMove => {
  const move = classifyDeckMove(state, before, startedGame);
  switch (move) {
    case 'kickoff': {
      // The host used to push the deck it had built itself, which made the
      // opening order the host's to choose. buildDeck runs here instead.
      const deck = buildDeck(state.initialCards);
      state.currentCard = deck.shift() ?? null;
      state.cards = deck;
      break;
    }
    case 'advance':
      drawNextCardForRoom(state);
      break;
    case 'undo':
      restoreDeckForUndo(state, before);
      break;
    case 'teardown':
      // What endGame's own push used to carry (`status: 'lobby'` alongside
      // `cards: []` and `currentCard: null`) and can no longer write itself.
      state.cards = [];
      state.currentCard = null;
      break;
    case 'hold':
      break;
  }
  return move;
};
