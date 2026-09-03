/**
 * @vitest-environment node
 *
 * The server's own deck moves. Every card a game deals now comes from here or
 * from the two paths that already dealt server-side (turnTimers'
 * advanceTurnOnTimeout, rooms' handleActivePlayerRemoved) — a push can no
 * longer write `cards` or `currentCard` at all, so what a turn advance deals
 * is decided here, AFTER the push that advanced the turn has landed.
 */
import { describe, it, expect } from 'vitest';
import { readDeckContext, classifyDeckMove, settleDeck } from './deckAuthority';
import { createRoom } from './rooms';
import { MAX_DECK_SIZE } from './pushValidation';
import { makeServerPlayer as makePlayer } from './socketTestHarness';
import type { RoomState } from './roomTypes';
import type { CardType, TurnSummary } from '../src/types';

const DECK: CardType[] = ['300', '200', 'Stop', 'x2'];

const playing = (over: Partial<RoomState> = {}): RoomState => {
  const state = createRoom('sock-Alice').state;
  state.players = ['Alice', 'Bob'].map(n => makePlayer(n));
  state.status = 'playing';
  state.currentPlayerIndex = 0;
  state.currentCard = 'Kniffel';
  state.cards = [...DECK];
  Object.assign(state, over);
  return state;
};

// What calculateNextTurn leaves behind for the seat whose turn just ended —
// the signature classifyDeckMove reads a real advance off.
const handOverToSeat = (state: RoomState, nextIndex: number, endedBy: string): void => {
  state.currentPlayerIndex = nextIndex;
  state.previousCard = 'Kniffel';
  state.previousPlayerName = endedBy;
};

const chainSummary = (cards: CardType[]): TurnSummary => ({
  cards: cards.map((card, i) => ({ card, completed: i < cards.length - 1 })),
  tuttoCount: 0,
  plusMinusScores: [],
  ended: 'banked',
});

describe('classifyDeckMove', () => {
  it('a kickoff deals a whole new deck, whatever the room was holding', () => {
    const state = playing();
    expect(classifyDeckMove(state, readDeckContext(state), true)).toBe('kickoff');
  });

  it('a push that only moves dice around leaves the deck alone', () => {
    const state = playing();
    // The overwhelmingly common push: same seat, same turn, a score edit or a
    // roster stat ticking over. Dealing here would burn a card per keystroke.
    expect(classifyDeckMove(state, readDeckContext(state), false)).toBe('hold');
  });

  it('a turn handed to the next seat deals that seat its card', () => {
    const state = playing();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('a moved index with no turn behind it deals nothing', () => {
    // A stale client re-pushing an index the room has already moved past. The
    // index alone used to be the whole signal, which let such a push burn a
    // card off the deck for a turn nobody played. A real advance always names
    // the seat it took the turn from.
    const state = playing();
    const before = readDeckContext(state);
    state.currentPlayerIndex = 1;
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('an advance naming a seat that was not the one playing deals nothing', () => {
    const state = playing();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Bob');
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('a turn given back to the seat that played it is an undo', () => {
    // calculateUndo hands the turn to previousPlayerName's seat and clears the
    // whole previous-turn record (noUndoableTurn) in the same push.
    const state = playing({ currentPlayerIndex: 1, previousCard: 'Kniffel', previousPlayerName: 'Alice' });
    const before = readDeckContext(state);
    state.currentPlayerIndex = 0;
    state.previousCard = null;
    state.previousPlayerName = null;
    expect(classifyDeckMove(state, before, false)).toBe('undo');
  });

  it('the game ending keeps the card it ended on', () => {
    // The winning push nulls currentPlayerIndex; the end screen still names
    // the card the winning turn was played on.
    const state = playing();
    const before = readDeckContext(state);
    state.finished = true;
    state.currentPlayerIndex = null;
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('a return to the lobby tears the deck down', () => {
    const state = playing();
    const before = readDeckContext(state);
    state.status = 'lobby';
    state.currentPlayerIndex = null;
    expect(classifyDeckMove(state, before, false)).toBe('teardown');
  });
});

describe('settleDeck', () => {
  it('kickoff builds a real deck and deals its top card', () => {
    const state = playing({ initialCards: { '300': 2, '400': 2 } as RoomState['initialCards'] });
    settleDeck(state, readDeckContext(state), true);

    expect(state.currentCard).not.toBeNull();
    // Four cards built, one dealt.
    expect(state.cards).toHaveLength(3);
    expect([...state.cards, state.currentCard].sort()).toEqual(['300', '300', '400', '400']);
  });

  it('advance takes exactly the top card, and nothing else moves', () => {
    const state = playing();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    settleDeck(state, before, false);

    expect(state.currentCard).toBe('300');
    expect(state.cards).toEqual(['200', 'Stop', 'x2']);
  });

  it('advance out of an exhausted deck reshuffles rather than dealing null', () => {
    const state = playing({ cards: [], initialCards: { '300': 3 } as RoomState['initialCards'] });
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    settleDeck(state, before, false);

    expect(state.currentCard).toBe('300');
    expect(state.cards).toEqual(['300', '300']);
  });

  it('undo re-deals the undone turn\'s first card and puts the rest back on top', () => {
    // The exact reconstruction calculateUndo does client-side, done here from
    // the server's OWN pre-push record: the undone turn gives back everything
    // but the card it is re-dealt, and the turn being discarded gives back the
    // card it was sitting on.
    const state = playing({
      currentPlayerIndex: 1,
      currentCard: 'x2',
      previousCard: 'Kniffel',
      previousPlayerName: 'Alice',
      previousTurnSummary: chainSummary(['Kniffel', '300', '400']),
    });
    const before = readDeckContext(state);
    state.currentPlayerIndex = 0;
    state.previousCard = null;
    state.previousPlayerName = null;
    state.previousTurnSummary = null;
    settleDeck(state, before, false);

    expect(state.currentCard).toBe('Kniffel');
    expect(state.cards).toEqual(['300', '400', 'x2', ...DECK]);
  });

  it('undo of a modernized turn re-deals the previous card alone', () => {
    const state = playing({
      currentPlayerIndex: 1, currentCard: 'x2',
      previousCard: 'Kniffel', previousPlayerName: 'Alice', previousTurnSummary: null,
    });
    const before = readDeckContext(state);
    state.currentPlayerIndex = 0;
    state.previousCard = null;
    state.previousPlayerName = null;
    settleDeck(state, before, false);

    expect(state.currentCard).toBe('Kniffel');
    expect(state.cards).toEqual(['x2', ...DECK]);
  });

  it('undo gives back the WHOLE chain the discarded turn had drawn', () => {
    // liveTurnState is the only record of the cards a turn in progress took
    // off the deck. Putting back only the card in play loses the rest for the
    // remainder of the game.
    const state = playing({
      currentPlayerIndex: 1, currentCard: 'x2',
      previousCard: 'Kniffel', previousPlayerName: 'Alice', previousTurnSummary: null,
      liveTurnState: {
        keptDice: [], currentRoll: [], kniffelProgress: [], turnScore: 0, tuttosThisTurn: 0,
        cardsThisTurn: ['500', '600', 'x2'],
      },
    });
    const before = readDeckContext(state);
    state.currentPlayerIndex = 0;
    state.previousCard = null;
    state.previousPlayerName = null;
    settleDeck(state, before, false);

    expect(state.cards).toEqual(['500', '600', 'x2', ...DECK]);
  });

  it('undo cannot grow the deck past a full one', () => {
    // previousTurnSummary and liveTurnState are both CLIENT-pushed fields, so
    // the cards an undo gives back are ultimately client-chosen. Bounded per
    // undo by MAX_CHAIN_CARDS, they still accumulate across repeated
    // push-a-summary-then-undo cycles — an unbounded array on the server, and
    // one no client could ever push back once past MAX_DECK_SIZE.
    const state = playing({
      currentPlayerIndex: 1, currentCard: 'x2',
      previousCard: 'Kniffel', previousPlayerName: 'Alice', previousTurnSummary: null,
      cards: Array<CardType>(MAX_DECK_SIZE).fill('300'),
    });
    const before = readDeckContext(state);
    state.currentPlayerIndex = 0;
    state.previousCard = null;
    state.previousPlayerName = null;
    settleDeck(state, before, false);

    expect(state.cards).toHaveLength(MAX_DECK_SIZE);
    expect(state.cards[0], 'the restored card is kept, the tail is what is dropped').toBe('x2');
  });

  it('teardown empties the deck the lobby has no use for', () => {
    const state = playing();
    const before = readDeckContext(state);
    state.status = 'lobby';
    state.currentPlayerIndex = null;
    settleDeck(state, before, false);

    expect(state.cards).toEqual([]);
    expect(state.currentCard).toBeNull();
  });

  it('hold leaves both the deck and the card exactly as they were', () => {
    const state = playing();
    settleDeck(state, readDeckContext(state), false);

    expect(state.cards).toEqual(DECK);
    expect(state.currentCard).toBe('Kniffel');
  });
});
