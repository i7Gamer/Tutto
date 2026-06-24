import { describe, it, expect } from 'vitest';
import { getLeaders, buildGlobalStatsPayload, shuffleArray, calculateNextTurn, calculateUndo } from './coreGameEngine';

const makePlayer = (name, overrides = {}) => ({
  name, score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
  timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
  feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
  ...overrides
});

const makeState = (overrides = {}) => ({
  players: [makePlayer('Alice'), makePlayer('Bob')],
  currentPlayerIndex: 0,
  currentCard: '200',
  round: 1,
  winningScore: 6000,
  cards: ['200', '200'],
  initialCards: { '200': 5 },
  previousCard: null,
  previousScore: null,
  previousLeaders: null,
  ...overrides
});

describe('coreGameEngine', () => {
  describe('shuffleArray', () => {
    it('returns an array of the same length with same elements', () => {
      const arr = [1, 2, 3, 4, 5];
      const shuffled = shuffleArray(arr);
      expect(shuffled.length).toBe(arr.length);
      expect([...shuffled].sort()).toEqual([...arr].sort());
      expect(shuffled).not.toBe(arr); // should be a new array
    });
  });

  describe('getLeaders', () => {
    it('returns an empty array if no players', () => {
      expect(getLeaders([])).toEqual([]);
    });

    it('returns the player with the highest score', () => {
      const players = [{ name: 'A', score: 100 }, { name: 'B', score: 200 }];
      expect(getLeaders(players)).toEqual([{ name: 'B', score: 200 }]);
    });

    it('returns multiple players if there is a tie for the highest score', () => {
      const players = [
        { name: 'A', score: 200 },
        { name: 'B', score: 200 },
        { name: 'C', score: 100 }
      ];
      expect(getLeaders(players)).toEqual([
        { name: 'A', score: 200 },
        { name: 'B', score: 200 }
      ]);
    });
  });

  describe('buildDeck', () => {
    it('builds a deck excluding cards with zero count', () => {
      const initialCards = { '200': 5, 'Stop': 0, 'Kleeblatt': 1 };
      const { buildDeck } = require('./coreGameEngine');
      const deck = buildDeck(initialCards);
      expect(deck.length).toBe(6);
      expect(deck.includes('Stop')).toBe(false);
      expect(deck.filter(c => c === 'Kleeblatt').length).toBe(1);
      expect(deck.filter(c => c === '200').length).toBe(5);
    });
  });

  describe('buildGlobalStatsPayload', () => {
    it('correctly aggregates stats from multiple players', () => {
      const finalPlayers = [
        {
          name: 'Alice',
          timesPlusMinusCompleted: 1, timesPlusMinusFailed: 1,
          timesKniffelCompleted: 1, timesKniffelFailed: 0,
          timesSkipped: 2, timesFeuerwerkReceived: 1,
          timesKleeblattFailed: 1, timesKleeblattCompleted: 0,
          timesx2Received: 2, totalTurns: 5, score: 3000,
          feuerwerkPointsScored: 500, x2PointsScored: 800,
          feuerwerkBusts: 1, x2Busts: 1, busts: 2
        },
        {
          name: 'Bob',
          timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0,
          timesKniffelCompleted: 0, timesKniffelFailed: 0,
          timesSkipped: 0, timesFeuerwerkReceived: 0,
          timesKleeblattFailed: 0, timesKleeblattCompleted: 0,
          timesx2Received: 0, totalTurns: 3, score: 1000,
          feuerwerkPointsScored: 0, x2PointsScored: 0,
          feuerwerkBusts: 0, x2Busts: 0, busts: 1
        }
      ];

      const payload = buildGlobalStatsPayload(finalPlayers, 120, true);

      expect(payload).toEqual({
        gamesPlayed: 1,
        totalPlaytime: 120,
        totalPlusMinus: 2,
        totalKniffel: 1,
        totalStop: 2,
        totalFeuerwerk: 1,
        totalKleeblatt: 1,
        totalKleeblattCompleted: 0,
        totalx2: 2,
        totalTurns: 8,
        totalScore: 4000,
        totalPlusMinusCompleted: 1,
        totalKniffelCompleted: 1,
        totalFeuerwerkPoints: 500,
        totalx2Points: 800,
        totalFeuerwerkBusts: 1,
        totalx2Busts: 1,
        totalBusts: 3,
        highestTurnScore: 0,
        fastestWinTurns: 5,
        fastestLossTurns: 3,
        isDefaultGame: true
      });
    });
  });

  // Direct unit tests for the shared turn engine. Previously this logic was
  // only covered indirectly through the (now removed) useGameLogic /
  // useOnlineGame hooks; these tests exercise calculateNextTurn / calculateUndo
  // — the functions the live zustand store actually calls.
  describe('calculateNextTurn', () => {
    it('adds the score to the current player and advances to the next player', () => {
      const result = calculateNextTurn(makeState(), 500, true);
      expect(result.players[0].score).toBe(500);
      expect(result.players[0].totalTurns).toBe(1);
      expect(result.isGameOver).toBe(false);
      expect(result.nextIndex).toBe(1);
      expect(result.drawnCard).toBe('200');
    });

    it('counts a 0-point result on a regular card as a bust', () => {
      const result = calculateNextTurn(makeState(), 0, false);
      expect(result.players[0].busts).toBe(1);
      expect(result.players[0].totalTurns).toBe(1);
    });

    it('a successful turn is not a bust', () => {
      const result = calculateNextTurn(makeState(), 500, true);
      expect(result.players[0].busts).toBe(0);
    });

    it('Stop card is skipped, not a bust', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Stop' }), 0, false);
      expect(result.players[0].timesSkipped).toBe(1);
      expect(result.players[0].busts).toBe(0);
    });

    it.each(['Plus_Minus', 'Kniffel', 'Kleeblatt'])(
      'failing the Yes/No card %s does not count as a bust',
      (card) => {
        const result = calculateNextTurn(makeState({ currentCard: card }), 0, false);
        expect(result.players[0].totalTurns).toBe(1);
        expect(result.players[0].busts).toBe(0);
      }
    );

    it('Kleeblatt success wins the game, sets score to 999999 and nextIndex null', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Kleeblatt' }), 0, true);
      expect(result.players[0].score).toBe(999999);
      expect(result.players[0].timesKleeblattCompleted).toBe(1);
      expect(result.isGameOver).toBe(true);
      expect(result.nextIndex).toBeNull();
    });

    it('Kleeblatt success sets isRoundEnd so the chart captures the final scores', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Kleeblatt' }), 0, true);
      expect(result.isRoundEnd).toBe(true);
    });

    it('Kleeblatt failure increments timesKleeblattFailed and continues', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Kleeblatt' }), 0, false);
      expect(result.players[0].timesKleeblattFailed).toBe(1);
      expect(result.isGameOver).toBe(false);
    });

    it('Plus_Minus success by a non-leader deducts 1000 from the leader (bounded at 0)', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 2000 }), makePlayer('Bob', { score: 0 })],
        currentPlayerIndex: 1,
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.players[0].score).toBe(1000); // Alice 2000 - 1000
      expect(result.players[0].times1000PointsDeducted).toBe(1);
      expect(result.players[1].score).toBe(1000); // Bob 0 + 1000
      expect(result.players[1].timesPlusMinusCompleted).toBe(1);
      expect(result.previousLeaders).toEqual([expect.objectContaining({ name: 'Alice', score: 2000 })]);
    });

    it('Plus_Minus deduction never takes the leader below zero', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 500 }), makePlayer('Bob', { score: 0 })],
        currentPlayerIndex: 1,
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.players[0].score).toBe(0); // max(0, 500 - 1000)
    });

    it('Plus_Minus success by the current leader deducts from no one', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 2000 }), makePlayer('Bob', { score: 0 })],
        currentPlayerIndex: 0,
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.players[0].score).toBe(3000); // 2000 + 1000, no self-deduction
      expect(result.previousLeaders).toBeNull();
    });

    it('Plus_Minus failure increments timesPlusMinusFailed', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Plus_Minus' }), 0, false);
      expect(result.players[0].timesPlusMinusFailed).toBe(1);
    });

    it('Kniffel success scores 2000', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Kniffel' }), 0, true);
      expect(result.players[0].score).toBe(2000);
      expect(result.players[0].timesKniffelCompleted).toBe(1);
    });

    it('Kniffel failure scores nothing and increments timesKniffelFailed', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Kniffel' }), 0, false);
      expect(result.players[0].score).toBe(0);
      expect(result.players[0].timesKniffelFailed).toBe(1);
    });

    it('tracks x2 received and points scored', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'x2' }), 500, true);
      expect(result.players[0].timesx2Received).toBe(1);
      expect(result.players[0].x2PointsScored).toBe(500);
    });

    it('tracks an x2 bust', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'x2' }), 0, false);
      expect(result.players[0].x2Busts).toBe(1);
      expect(result.players[0].busts).toBe(1);
      expect(result.players[0].x2PointsScored).toBe(0);
    });

    it('tracks Feuerwerk received, points and busts', () => {
      const scored = calculateNextTurn(makeState({ currentCard: 'Feuerwerk' }), 1500, false);
      expect(scored.players[0].feuerwerkPointsScored).toBe(1500);
      expect(scored.players[0].timesFeuerwerkReceived).toBe(1);

      const busted = calculateNextTurn(makeState({ currentCard: 'Feuerwerk' }), 0, false);
      expect(busted.players[0].feuerwerkBusts).toBe(1);
    });

    it('records the highest turn score', () => {
      const result = calculateNextTurn(makeState(), 1200, true);
      expect(result.players[0].highestTurnScore).toBe(1200);
    });

    it('returns a brand new players array and player objects (so React detects changes)', () => {
      const state = makeState();
      const result = calculateNextTurn(state, 200, true);
      expect(result.players).not.toBe(state.players);
      expect(result.players[0]).not.toBe(state.players[0]);
    });

    describe('win condition', () => {
      it('does not end the game until the round completes', () => {
        const result = calculateNextTurn(makeState({ currentPlayerIndex: 0 }), 6500, false);
        expect(result.isGameOver).toBe(false);
        expect(result.nextIndex).toBe(1);
      });

      it('ends the game when the sole leader is at/above the winning score at round end', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 6500 }), makePlayer('Bob', { score: 0 })],
          currentPlayerIndex: 1,
        });
        const result = calculateNextTurn(state, 0, false);
        expect(result.isRoundEnd).toBe(true);
        expect(result.isGameOver).toBe(true);
        expect(result.nextIndex).toBeNull();
      });

      it('does not end the game on a tie at the winning score', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 6000 }), makePlayer('Bob', { score: 6000 })],
          currentPlayerIndex: 1,
        });
        const result = calculateNextTurn(state, 0, false);
        expect(result.isRoundEnd).toBe(true);
        expect(result.isGameOver).toBe(false);
        expect(result.nextRound).toBe(2);
      });
    });

    it('rebuilds and reshuffles the deck when it is exhausted', () => {
      const result = calculateNextTurn(makeState({ cards: [] }), 500, true);
      expect(result.drawnCard).toBe('200');
      expect(result.newDeck.length).toBe(4); // initialCards { '200': 5 } minus the drawn one
    });
  });

  describe('calculateUndo', () => {
    it('returns null when there is no previous card', () => {
      expect(calculateUndo(makeState({ previousCard: null }))).toBeNull();
    });

    it('returns null when the previous card was Stop (cannot be undone)', () => {
      expect(calculateUndo(makeState({ previousCard: 'Stop' }))).toBeNull();
    });

    it('reverts score, turn ownership, totalTurns and busts', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 0, totalTurns: 1, busts: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Stop',
        previousCard: '200',
        previousScore: 0,
        previousWasBust: true,
      });
      const result = calculateUndo(state);
      expect(result.nextIndex).toBe(0);
      expect(result.players[0].totalTurns).toBe(0);
      expect(result.players[0].busts).toBe(0);
      expect(result.drawnCard).toBe('200');
    });

    it('reverses Feuerwerk busts, points and received count (Bug 1)', () => {
      const state = makeState({
        players: [makePlayer('Alice', { totalTurns: 1, busts: 1, feuerwerkBusts: 1, timesFeuerwerkReceived: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Feuerwerk',
        previousScore: 0,
        previousWasBust: true,
      });
      const result = calculateUndo(state);
      expect(result.players[0].feuerwerkBusts).toBe(0);
      expect(result.players[0].timesFeuerwerkReceived).toBe(0);
      expect(result.players[0].busts).toBe(0);
      expect(result.players[0].totalTurns).toBe(0);
    });

    it('reverses x2 busts, points and received count (Bug 1)', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 500, totalTurns: 1, timesx2Received: 1, x2PointsScored: 500 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'x2',
        previousScore: 500,
        previousWasBust: false,
      });
      const result = calculateUndo(state);
      expect(result.players[0].x2PointsScored).toBe(0);
      expect(result.players[0].timesx2Received).toBe(0);
      expect(result.players[0].score).toBe(0);
    });

    it('only touches Feuerwerk stats based on previousCard, not currentCard (Bug 2)', () => {
      // Previous player played '200'; the card now showing is Feuerwerk.
      const state = makeState({
        players: [makePlayer('Alice', { score: 300, totalTurns: 1, timesFeuerwerkReceived: 0 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Feuerwerk',
        previousCard: '200',
        previousScore: 300,
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesFeuerwerkReceived).toBe(0); // untouched
    });

    it('restores leaders from the Plus_Minus snapshot and bounds the undo correctly', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 1000, times1000PointsDeducted: 1 }), makePlayer('Bob', { score: 1000, totalTurns: 1, timesPlusMinusCompleted: 1 })],
        currentPlayerIndex: 0, // round 2, Alice's turn again — undo Bob's Plus_Minus
        round: 2,
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [{ name: 'Alice', score: 2000 }],
      });
      const result = calculateUndo(state);
      expect(result.isRoundEndUndo).toBe(true);
      expect(result.nextIndex).toBe(1); // wrapped back to Bob
      expect(result.players[0].score).toBe(2000); // Alice restored
      expect(result.players[0].times1000PointsDeducted).toBe(0);
      expect(result.players[1].score).toBe(0); // Bob loses his 1000
      expect(result.players[1].timesPlusMinusCompleted).toBe(0);
    });

    it('decrements timesPlusMinusFailed when undoing a failed Plus_Minus', () => {
      const state = makeState({
        players: [makePlayer('Alice', { totalTurns: 1, timesPlusMinusFailed: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Plus_Minus',
        previousScore: 0,
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesPlusMinusFailed).toBe(0);
    });

    it('puts the undone cards back on top of the deck', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 500, totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Stop',
        cards: ['600'],
        previousCard: '200',
        previousScore: 500,
      });
      const result = calculateUndo(state);
      expect(result.newDeck).toEqual(['Stop', '600']);
      expect(result.drawnCard).toBe('200');
    });

    it('returns null when undoing on round 1, player 0', () => {
      const state = makeState({
        players: [makePlayer('Alice', { totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 0,
        round: 1,
        previousCard: '200',
        previousScore: 0,
      });
      const result = calculateUndo(state);
      expect(result).toBeNull();
    });

    it('restores highestTurnScore', () => {
      const state = makeState({
        players: [makePlayer('Alice', { highestTurnScore: 2000 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: '200',
        previousScore: 1000,
        previousHighestTurnScore: 1000,
      });
      const result = calculateUndo(state);
      expect(result.players[0].highestTurnScore).toBe(1000);
    });

    it('reverses Kleeblatt failure', () => {
      const state = makeState({
        players: [makePlayer('Alice', { timesKleeblattFailed: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Kleeblatt',
        previousScore: 0,
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesKleeblattFailed).toBe(0);
    });

    it('reverses Kleeblatt completion', () => {
      const state = makeState({
        players: [makePlayer('Alice', { timesKleeblattCompleted: 1, score: 999999 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Kleeblatt',
        previousScore: 500,
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesKleeblattCompleted).toBe(0);
      expect(result.players[0].score).toBe(999999 - 500);
    });
  });
});
