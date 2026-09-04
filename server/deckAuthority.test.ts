/**
 * @vitest-environment node
 *
 * The server's own deck moves. Every card a game deals now comes from here or
 * from the two paths that already dealt server-side (turnTimers'
 * advanceTurnOnTimeout, rooms' handleActivePlayerRemoved) — a push can no
 * longer write `cards` or `currentCard` at all, so what a turn advance deals
 * is decided here, AFTER the push that advanced the turn has landed.
 *
 * Both halves of that decision are made from state the SERVER holds: which
 * move a push made (the seat the room was already on, never the
 * previousPlayerName riding in on the push) and, for an undo, which cards to
 * give back (Room.dealtLastTurn/dealtThisTurn, never the pushed
 * previousTurnSummary/liveTurnState). The tests at the end of each block pin
 * that, because reading either from the push let a player choose their own
 * next card.
 */
import { describe, it, expect } from 'vitest';
import { readDeckContext, classifyDeckMove, settleDeck } from './deckAuthority';
import { createRoom } from './rooms';
import { MAX_DECK_SIZE } from './pushValidation';
import { makeServerPlayer as makePlayer } from './socketTestHarness';
import type { Room, RoomState } from './roomTypes';
import type { CardType, TurnSummary } from '../src/types';

const DECK: CardType[] = ['300', '200', 'Stop', 'x2'];

const playing = (over: Partial<RoomState> = {}, names = ['Alice', 'Bob']): Room => {
  const room = createRoom('sock-Alice');
  const state = room.state;
  state.players = names.map(n => makePlayer(n));
  state.status = 'playing';
  state.currentPlayerIndex = 0;
  state.currentCard = 'Kniffel';
  state.cards = [...DECK];
  Object.assign(state, over);
  return room;
};

// What calculateNextTurn leaves behind for the seat whose turn just ended —
// the signature classifyDeckMove reads a real advance off. `endedBy` is the
// name the push CLAIMS the turn came from; it no longer decides anything, and
// the tests below use that to prove it.
const handOverToSeat = (state: RoomState, nextIndex: number, endedBy: string): void => {
  state.currentPlayerIndex = nextIndex;
  state.previousCard = 'Kniffel';
  state.previousPlayerName = endedBy;
};

// The push an undo sends: the turn goes back a seat and the whole
// previous-turn record is cleared (calculateUndo's noUndoableTurn).
const undoPush = (state: RoomState, toIndex: number): void => {
  state.currentPlayerIndex = toIndex;
  state.previousCard = null;
  state.previousPlayerName = null;
  state.previousTurnSummary = null;
};

const chainSummary = (cards: CardType[]): TurnSummary => ({
  cards: cards.map((card, i) => ({ card, completed: i < cards.length - 1 })),
  tuttoCount: 0,
  plusMinusScores: [],
  ended: 'banked',
});

/**
 * A room mid-game with a turn behind it, set up the way the server's own deal
 * log would have left it: Alice (seat 0) opened her turn on `lastTurn[0]` and
 * chain-drew the rest of it; Bob (seat 1) is now playing, having opened on
 * `thisTurn`'s last card.
 */
const withDealtTurns = (lastTurn: CardType[], thisTurn: CardType[], over: Partial<RoomState> = {}): Room => {
  const room = playing({
    currentPlayerIndex: 1,
    currentCard: thisTurn[thisTurn.length - 1] ?? null,
    previousCard: lastTurn[0] ?? null,
    previousPlayerName: 'Alice',
    ...over,
  });
  room.dealtLastTurn = [...lastTurn];
  room.dealtThisTurn = [...thisTurn];
  return room;
};

describe('classifyDeckMove', () => {
  it('a kickoff deals a whole new deck, whatever the room was holding', () => {
    const { state } = playing();
    expect(classifyDeckMove(state, readDeckContext(state), true)).toBe('kickoff');
  });

  it('a push that only moves dice around leaves the deck alone', () => {
    const { state } = playing();
    // The overwhelmingly common push: same seat, same turn, a score edit or a
    // roster stat ticking over. Dealing here would burn a card per keystroke.
    expect(classifyDeckMove(state, readDeckContext(state), false)).toBe('hold');
  });

  it('a turn handed to the next seat deals that seat its card', () => {
    const { state } = playing();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('the first advance of a game deals, with no turn behind it', () => {
    // Why the advance cannot be anchored on the room's OWN previousCard, the
    // obvious server-held stand-in for the pushed one: nothing has been played
    // yet when the opening turn is handed on, so that anchor would withhold
    // the second card of every single game.
    const { state } = playing();
    expect(state.previousCard, 'no turn has been played yet').toBeNull();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('clearing previousCard cannot withhold the next seat\'s card', () => {
    // previousCard arrives in the very push being judged (applyPreviousCard
    // writes whatever it carries, null included), so reading it as proof a
    // turn was played let the active player push `previousCard: null` beside
    // an honest hand-over: no card was dealt, and the next seat inherited the
    // one already in play — which the pusher had read off the broadcast deck
    // before deciding to keep it. The card the room was HOLDING says the same
    // thing and is the server's own.
    const { state } = playing({ previousCard: 'Kniffel', previousPlayerName: 'Alice' }, ['Alice', 'Bob', 'Carol']);
    const before = readDeckContext(state);
    state.currentPlayerIndex = 1;
    state.previousCard = null;
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('and cannot withhold it at two seats either', () => {
    // Two seats is where the same push used to land on 'undo' instead of
    // 'hold' (the seat before and the seat after are one and the same), and
    // the deck was rewound for a turn nobody undid. With no undoable turn
    // behind the room the undo test cannot fire at all, so this is a plain
    // advance — the tie the two-seat case does still have is settled by the
    // undo test above, which is checked first.
    const { state } = playing();
    const before = readDeckContext(state);
    state.currentPlayerIndex = 1;
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('a seat move in a room holding no card deals nothing', () => {
    // The advance anchor's negative branch. Unreachable today: every path that
    // nulls currentCard mid-game (turnTimers' game over and its
    // abortGameIfLowPlayers, rooms.handleActivePlayerRemoved's game over) sets
    // `finished` or drops the room to the lobby in the same breath, and both
    // are answered above. This is the backstop for one that does not.
    const { state } = playing({ currentCard: null });
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Alice');
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('a jump of more than one seat is not an advance', () => {
    // Turn order is strictly roster order (calculateNextTurn takes index + 1
    // and skips nobody), so a push landing anywhere else did not advance a
    // turn — whatever it claims about where it came from.
    const { state } = playing({}, ['Alice', 'Bob', 'Carol']);
    const before = readDeckContext(state);
    handOverToSeat(state, 2, 'Alice');
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('an advance still deals when the push misnames the seat it came from', () => {
    // previousPlayerName used to be the discriminator — and it arrives in the
    // very push it was meant to vouch for. Naming anyone but the seat that was
    // playing turned an ordinary advance into a 'hold', which left the next
    // player on the card already in play: a free, repeatable way to withhold a
    // deal after reading the broadcast deck. The seat the room was on decides
    // it now, so the lie changes nothing.
    const { state } = playing();
    const before = readDeckContext(state);
    handOverToSeat(state, 1, 'Bob');
    expect(classifyDeckMove(state, before, false)).toBe('advance');
  });

  it('a turn given back to the seat that played it is an undo', () => {
    // calculateUndo hands the turn to the seat BEFORE the one playing and
    // clears the whole previous-turn record (noUndoableTurn) in the same push.
    const { state } = playing({ currentPlayerIndex: 1, previousCard: 'Kniffel', previousPlayerName: 'Alice' });
    const before = readDeckContext(state);
    undoPush(state, 0);
    expect(classifyDeckMove(state, before, false)).toBe('undo');
  });

  it('the seat an undo goes back to wraps at the top of the roster', () => {
    // A round-end undo: seat 0 hands back to the last seat, which is the one
    // that played the previous round's final turn.
    const { state } = playing({ currentPlayerIndex: 0, previousCard: 'Kniffel', previousPlayerName: 'Carol' }, ['Alice', 'Bob', 'Carol']);
    const before = readDeckContext(state);
    undoPush(state, 2);
    expect(classifyDeckMove(state, before, false)).toBe('undo');
  });

  it('an undo cannot be aimed at a seat other than the one that just played', () => {
    // The mirror of the advance case: previousPlayerName used to pick the
    // seat, so planting it let a player trigger the deck restore from a seat
    // the turn had never been at.
    //
    // Four seats, because the seat an aimed undo would have to miss by is the
    // one an advance hits: from the last seat of a three-player game the only
    // index left to aim at is the wrap-around successor, which IS a round-end
    // advance and deals accordingly. Here seat 1 is neither the predecessor
    // (2) nor the successor (0) of the seat the room was on.
    const { state } = playing({ currentPlayerIndex: 3, previousCard: 'Kniffel', previousPlayerName: 'Alice' }, ['Alice', 'Bob', 'Carol', 'Dave']);
    const before = readDeckContext(state);
    undoPush(state, 1);
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('the game ending keeps the card it ended on', () => {
    // The winning push nulls currentPlayerIndex; the end screen still names
    // the card the winning turn was played on.
    const { state } = playing();
    const before = readDeckContext(state);
    state.finished = true;
    state.currentPlayerIndex = null;
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('a game ended by the last player leaving holds too, card and all', () => {
    // rooms.handleActivePlayerRemoved's game-over branch nulls currentCard
    // alongside finished and currentPlayerIndex — the one place a room in
    // status 'playing' is left holding no card. A push landing after it must
    // still deal nothing, whichever seat it names.
    const { state } = playing();
    const before = readDeckContext(state);
    state.finished = true;
    state.currentPlayerIndex = null;
    state.currentCard = null;
    expect(classifyDeckMove(state, before, false)).toBe('hold');
  });

  it('a return to the lobby tears the deck down', () => {
    const { state } = playing();
    const before = readDeckContext(state);
    state.status = 'lobby';
    state.currentPlayerIndex = null;
    expect(classifyDeckMove(state, before, false)).toBe('teardown');
  });
});

describe('settleDeck', () => {
  it('kickoff builds a real deck and deals its top card', () => {
    const room = playing({ initialCards: { '300': 2, '400': 2 } as RoomState['initialCards'] });
    settleDeck(room, readDeckContext(room.state), true);

    expect(room.state.currentCard).not.toBeNull();
    // Four cards built, one dealt.
    expect(room.state.cards).toHaveLength(3);
    expect([...room.state.cards, room.state.currentCard].sort()).toEqual(['300', '300', '400', '400']);
  });

  it('kickoff starts the deal log over on the card it dealt', () => {
    // A new game has no undoable turn behind it, and the previous game's log
    // must not be able to give cards back into this one.
    const room = playing({ initialCards: { '300': 2 } as RoomState['initialCards'] });
    room.dealtLastTurn = ['Stop', 'Stop'];
    room.dealtThisTurn = ['Stop'];
    settleDeck(room, readDeckContext(room.state), true);

    expect(room.dealtLastTurn).toEqual([]);
    expect(room.dealtThisTurn).toEqual([room.state.currentCard]);
  });

  it('advance takes exactly the top card, and nothing else moves', () => {
    const room = playing();
    const before = readDeckContext(room.state);
    handOverToSeat(room.state, 1, 'Alice');
    settleDeck(room, before, false);

    expect(room.state.currentCard).toBe('300');
    expect(room.state.cards).toEqual(['200', 'Stop', 'x2']);
  });

  it('advance deals off the top even when the push clears previousCard', () => {
    // The withheld deal at the level of the deck itself: the next seat gets
    // the card the server turns over, not the one the pusher chose to sit on.
    const room = playing({ previousCard: 'Kniffel', previousPlayerName: 'Alice' }, ['Alice', 'Bob', 'Carol']);
    const before = readDeckContext(room.state);
    room.state.currentPlayerIndex = 1;
    room.state.previousCard = null;
    settleDeck(room, before, false);

    expect(room.state.currentCard).toBe('300');
    expect(room.state.cards).toEqual(['200', 'Stop', 'x2']);
  });

  it('advance rotates the deal log onto the new turn', () => {
    const room = withDealtTurns(['Kniffel', '600'], ['x2']);
    const before = readDeckContext(room.state);
    room.state.currentPlayerIndex = 0;
    room.state.previousCard = 'x2';
    room.state.previousPlayerName = 'Bob';
    settleDeck(room, before, false);

    expect(room.dealtLastTurn, 'the turn just played becomes the undoable one').toEqual(['x2']);
    expect(room.dealtThisTurn).toEqual([room.state.currentCard]);
  });

  it('advance out of an exhausted deck reshuffles rather than dealing null', () => {
    const room = playing({ cards: [], initialCards: { '300': 3 } as RoomState['initialCards'] });
    const before = readDeckContext(room.state);
    handOverToSeat(room.state, 1, 'Alice');
    settleDeck(room, before, false);

    expect(room.state.currentCard).toBe('300');
    expect(room.state.cards).toEqual(['300', '300']);
  });

  it('undo re-deals the undone turn\'s first card and puts the rest back on top', () => {
    // The exact reconstruction calculateUndo does client-side, done here from
    // the server's OWN deal log: the undone turn gives back everything but the
    // card it is re-dealt, and the turn being discarded gives back the card it
    // was sitting on.
    const room = withDealtTurns(['Kniffel', '300', '400'], ['x2']);
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.currentCard).toBe('Kniffel');
    expect(room.state.cards).toEqual(['300', '400', 'x2', ...DECK]);
  });

  it('undo of a modernized turn re-deals the previous card alone', () => {
    const room = withDealtTurns(['Kniffel'], ['x2']);
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.currentCard).toBe('Kniffel');
    expect(room.state.cards).toEqual(['x2', ...DECK]);
  });

  it('undo gives back the WHOLE chain the discarded turn had drawn', () => {
    // The turn being discarded was itself mid-chain. Putting back only the
    // card in play loses the rest for the remainder of the game.
    const room = withDealtTurns(['Kniffel'], ['500', '600', 'x2']);
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.cards).toEqual(['500', '600', 'x2', ...DECK]);
  });

  it('undo leaves the log describing the turn about to be replayed', () => {
    const room = withDealtTurns(['Kniffel', '300'], ['x2']);
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.dealtThisTurn, 'the replayed turn has been dealt its opening card').toEqual(['Kniffel']);
    expect(room.dealtLastTurn, 'and there is no undoable turn behind it').toEqual([]);
  });

  it('undo restores the cards the SERVER dealt, not the ones the push names', () => {
    // The attack this log exists to stop. previousTurnSummary and
    // liveTurnState are both pushable, so when the restore read them a player
    // got back exactly the cards they had named — and `currentCard` was
    // whichever one they put first. Repeating plant-a-summary-then-undo
    // prepended an arbitrary run of chosen cards to the deck.
    const room = withDealtTurns(['Kniffel', '300'], ['x2'], {
      previousTurnSummary: chainSummary(['600', '600', '600']),
      liveTurnState: {
        keptDice: [], currentRoll: [], kniffelProgress: [], turnScore: 0, tuttosThisTurn: 0,
        cardsThisTurn: ['600', '600'],
      },
    });
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.currentCard, 'not the 600 the push asked for').toBe('Kniffel');
    expect(room.state.cards).toEqual(['300', 'x2', ...DECK]);
    expect(room.state.cards).not.toContain('600');
  });

  it('an undo the server has no record of moves nothing at all', () => {
    // Only reachable by a push claiming an undo the room never saw: an honest
    // one always has a logged previous turn behind it. Falling back to the
    // pushed previousCard here would hand the caller a card of their choosing,
    // because applyPreviousCard takes any valid card without checking the room
    // was holding it -- which on the first turn of a game is free.
    const room = withDealtTurns([], ['Kniffel']);
    room.state.previousCard = '600';
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.currentCard, 'not the 600 the push named').toBe('Kniffel');
    expect(room.state.cards).toEqual(DECK);
  });

  it('undo cannot grow the deck past a full one', () => {
    // A backstop on a log the server writes itself: it cannot exceed
    // MAX_CHAIN_CARDS per turn, so this is unreachable honestly — but a deck
    // past MAX_DECK_SIZE is one no game could produce, and the cap keeps that
    // true whatever a future deal site does.
    const room = withDealtTurns(['Kniffel'], ['x2'], {
      cards: Array<CardType>(MAX_DECK_SIZE).fill('300'),
    });
    const before = readDeckContext(room.state);
    undoPush(room.state, 0);
    settleDeck(room, before, false);

    expect(room.state.cards).toHaveLength(MAX_DECK_SIZE);
    expect(room.state.cards[0], 'the restored card is kept, the tail is what is dropped').toBe('x2');
  });

  it('teardown empties the deck the lobby has no use for', () => {
    const room = playing();
    const before = readDeckContext(room.state);
    room.state.status = 'lobby';
    room.state.currentPlayerIndex = null;
    settleDeck(room, before, false);

    expect(room.state.cards).toEqual([]);
    expect(room.state.currentCard).toBeNull();
    expect(room.dealtThisTurn, 'and the log with it — the next game deals its own').toEqual([]);
    expect(room.dealtLastTurn).toEqual([]);
  });

  it('reports the move it made, for every one of them', () => {
    // settleDeck's return value is what a caller would branch on, and nothing
    // asserted it -- the tests above all prove the EFFECT and none the
    // classification the effect came from.
    const kickoff = playing({ initialCards: { '300': 2 } as RoomState['initialCards'] });
    expect(settleDeck(kickoff, readDeckContext(kickoff.state), true)).toBe('kickoff');

    const advanced = playing();
    const advBefore = readDeckContext(advanced.state);
    handOverToSeat(advanced.state, 1, 'Alice');
    expect(settleDeck(advanced, advBefore, false)).toBe('advance');

    const undone = withDealtTurns(['Kniffel'], ['x2']);
    const undoBefore = readDeckContext(undone.state);
    undoPush(undone.state, 0);
    expect(settleDeck(undone, undoBefore, false)).toBe('undo');

    const torn = playing();
    const tearBefore = readDeckContext(torn.state);
    torn.state.status = 'lobby';
    torn.state.currentPlayerIndex = null;
    expect(settleDeck(torn, tearBefore, false)).toBe('teardown');

    const held = playing();
    expect(settleDeck(held, readDeckContext(held.state), false)).toBe('hold');
  });

  it('hold leaves both the deck and the card exactly as they were', () => {
    const room = playing();
    settleDeck(room, readDeckContext(room.state), false);

    expect(room.state.cards).toEqual(DECK);
    expect(room.state.currentCard).toBe('Kniffel');
  });
});
