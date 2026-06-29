import { describe, it, expect } from 'vitest';
import { getLeaders, buildGlobalStatsPayload, shuffleArray, buildDeck, calculateNextTurn, calculateUndo, computeRankedPlayers } from './coreGameEngine';

const makePlayer = (name, overrides = {}) => ({
  name, score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
  timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
  feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
  highestTurnScore: 0,
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

  describe('computeRankedPlayers', () => {
    it('assigns sequential positions when all scores differ', () => {
      const result = computeRankedPlayers([
        { name: 'C', score: 3000 }, { name: 'A', score: 10000 }, { name: 'B', score: 5000 }
      ]);
      expect(result.map(p => p.position)).toEqual([1, 2, 3]);
      expect(result[0].name).toBe('A');
    });

    it('assigns same position to tied players and skips the next rank (1224 competition ranking)', () => {
      const result = computeRankedPlayers([
        { name: 'A', score: 10000 }, { name: 'B', score: 10000 }, { name: 'C', score: 5000 }
      ]);
      expect(result[0].position).toBe(1);
      expect(result[1].position).toBe(1);
      expect(result[2].position).toBe(3);
    });

    it('returns a new array of copied objects, not the originals', () => {
      const players = [{ name: 'A', score: 100 }];
      const result = computeRankedPlayers(players);
      expect(result).not.toBe(players);
      expect(result[0]).not.toBe(players[0]);
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
      const deck = buildDeck(initialCards);
      expect(deck.length).toBe(6);
      expect(deck.includes('Stop')).toBe(false);
      expect(deck.filter(c => c === 'Kleeblatt').length).toBe(1);
      expect(deck.filter(c => c === '200').length).toBe(5);
    });

    describe('smoothing algorithm — separation of duplicates', () => {
      it('nearly eliminates adjacent identical cards in standard diverse decks', () => {
        // Standard deck: most cards 5x, one card 10x
        // With 3 passes, the algorithm prevents most 3+ clusters; occasionally 2 remains
        const initialCards = {
          '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          'Kniffel': 10, 'Plus_Minus': 5, 'x2': 5,
          'Feuerwerk': 5, 'Kleeblatt': 5, 'Stop': 5
        };

        for (let run = 0; run < 10; run++) {
          const deck = buildDeck(initialCards);
          let maxCluster = 1;
          for (let i = 1; i < deck.length; i++) {
            let cluster = 1;
            while (i < deck.length && deck[i] === deck[i - 1]) {
              cluster++;
              i++;
            }
            maxCluster = Math.max(maxCluster, cluster);
          }
          // With diverse cards (55 total, 11 types) and 3 passes: max 2 adjacent (excellent)
          expect(maxCluster).toBeLessThanOrEqual(2);
        }
      });

      it('produces a valid distribution (correct card counts)', () => {
        const initialCards = {
          '200': 5, '300': 3, 'Kniffel': 10, 'x2': 4, 'Stop': 2
        };
        const deck = buildDeck(initialCards);

        expect(deck.length).toBe(24);
        expect(deck.filter(c => c === '200').length).toBe(5);
        expect(deck.filter(c => c === '300').length).toBe(3);
        expect(deck.filter(c => c === 'Kniffel').length).toBe(10);
        expect(deck.filter(c => c === 'x2').length).toBe(4);
        expect(deck.filter(c => c === 'Stop').length).toBe(2);
      });

      it('handles the high-frequency card case (10x) with good spreading', () => {
        const initialCards = { 'Kniffel': 10, '200': 5 };
        const deck = buildDeck(initialCards);

        // With 10 of the same card in 15 total (~67% frequency), 3 passes provide
        // good spreading. Most runs keep max cluster to 5; occasionally 6 appears.
        // This is a significant improvement over raw Fisher-Yates (~7+).
        let maxCluster = 1;
        for (let i = 1; i < deck.length; i++) {
          let cluster = 1;
          while (i < deck.length && deck[i] === deck[i - 1]) {
            cluster++;
            i++;
          }
          maxCluster = Math.max(maxCluster, cluster);
        }
        // With 3 passes: max 5–6 adjacent (balanced good performance vs. cost)
        expect(maxCluster).toBeLessThanOrEqual(6);
      });

      it('returns a new array each time (different shuffle)', () => {
        const initialCards = { '200': 5, '300': 5, '400': 5 };
        const deck1 = buildDeck(initialCards);
        const deck2 = buildDeck(initialCards);

        // Arrays should be different objects
        expect(deck1).not.toBe(deck2);
        // Content order should (almost certainly) be different
        expect(deck1).not.toEqual(deck2);
      });

      it('works with single card type (edge case)', () => {
        const initialCards = { '200': 1 };
        const deck = buildDeck(initialCards);
        expect(deck).toEqual(['200']);
      });

      it('works with two different card types', () => {
        const initialCards = { '200': 3, '300': 2 };
        const deck = buildDeck(initialCards);
        expect(deck.length).toBe(5);
        expect(deck.filter(c => c === '200').length).toBe(3);
        expect(deck.filter(c => c === '300').length).toBe(2);
      });

      it('handles many different card types (real game scenario)', () => {
        const initialCards = {
          '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          'Kniffel': 5, 'Plus_Minus': 5, 'x2': 5,
          'Feuerwerk': 5, 'Kleeblatt': 5, 'Stop': 5
        };
        const deck = buildDeck(initialCards);

        // Verify total count and no 3+ clusters
        expect(deck.length).toBe(55);

        let maxCluster = 1;
        for (let i = 1; i < deck.length; i++) {
          let cluster = 1;
          while (i < deck.length && deck[i] === deck[i - 1]) {
            cluster++;
            i++;
          }
          maxCluster = Math.max(maxCluster, cluster);
        }
        expect(maxCluster).toBeLessThanOrEqual(2);
      });
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

    describe('Plus_Minus card', () => {
      it('Plus_Minus: leader with exactly 1000 pts goes to 0 when non-leader succeeds', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 1000 }), makePlayer('Bob', { score: 0 })],
          currentPlayerIndex: 1,
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(0);    // Alice: 1000 - 1000 = 0
        expect(result.players[0].times1000PointsDeducted).toBe(1);
        expect(result.players[1].score).toBe(1000); // Bob: 0 + 1000
        expect(result.players[1].timesPlusMinusCompleted).toBe(1);
        expect(result.previousLeaders).toEqual([expect.objectContaining({ name: 'Alice', score: 1000 })]);
      });

      it('undo restores leader from 0 back to exactly 1000 after Plus_Minus', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 0, times1000PointsDeducted: 1 }), makePlayer('Bob', { score: 1000, totalTurns: 1, timesPlusMinusCompleted: 1 })],
          currentPlayerIndex: 0,
          round: 2,
          previousCard: 'Plus_Minus',
          previousScore: 1000,
          previousLeaders: [{ name: 'Alice', score: 1000 }],
        });
        const result = calculateUndo(state);
        expect(result.isRoundEndUndo).toBe(true);
        expect(result.players[0].score).toBe(1000); // Alice restored to exactly 1000
        expect(result.players[0].times1000PointsDeducted).toBe(0);
        expect(result.players[1].score).toBe(0);    // Bob loses his 1000
        expect(result.players[1].timesPlusMinusCompleted).toBe(0);
      });

      it('Plus_Minus success by a non-leader deducts 1000 from the single leader', () => {
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

      it('Plus_Minus can take the leader into negative score', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 400 }), makePlayer('Bob', { score: 0 })],
          currentPlayerIndex: 1,
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(-600); // 400 - 1000
        expect(result.players[0].times1000PointsDeducted).toBe(1);
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

      it('Plus_Minus deducts from multiple leaders with tied scores', () => {
        const state = makeState({
          players: [
            makePlayer('Alice', { score: 3000 }),
            makePlayer('Bob', { score: 3000 }),
            makePlayer('Charlie', { score: 1000 })
          ],
          currentPlayerIndex: 2,
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(2000); // Alice 3000 - 1000
        expect(result.players[1].score).toBe(2000); // Bob 3000 - 1000
        expect(result.players[0].times1000PointsDeducted).toBe(1);
        expect(result.players[1].times1000PointsDeducted).toBe(1);
        expect(result.players[2].score).toBe(2000); // Charlie 1000 + 1000
        expect(result.players[2].timesPlusMinusCompleted).toBe(1);
        expect(result.previousLeaders).toEqual([
          expect.objectContaining({ name: 'Alice', score: 3000 }),
          expect.objectContaining({ name: 'Bob', score: 3000 })
        ]);
      });

      it('Plus_Minus does not deduct when everyone has 0 points (no leader)', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 0 }), makePlayer('Bob', { score: 0 })],
          currentPlayerIndex: 0,
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(1000); // Alice 0 + 1000
        expect(result.players[1].score).toBe(0); // Bob untouched (is a "leader" himself)
        expect(result.players[0].timesPlusMinusCompleted).toBe(1);
        expect(result.previousLeaders).toBeNull(); // No deduction occurred
      });

      it('Plus_Minus does not deduct when the card holder is one of multiple leaders', () => {
        const state = makeState({
          players: [
            makePlayer('Alice', { score: 2000 }),
            makePlayer('Bob', { score: 2000 }),
            makePlayer('Charlie', { score: 0 })
          ],
          currentPlayerIndex: 0, // Alice is a leader
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(3000); // Alice 2000 + 1000, not deducted
        expect(result.players[1].score).toBe(2000); // Bob untouched (is a leader)
        expect(result.players[0].timesPlusMinusCompleted).toBe(1);
        expect(result.previousLeaders).toBeNull(); // No deduction occurred
      });

      it('Plus_Minus with low leader score can result in negative score', () => {
        const state = makeState({
          players: [
            makePlayer('Alice', { score: 400 }),
            makePlayer('Bob', { score: 200 }),
            makePlayer('Charlie', { score: 0 })
          ],
          currentPlayerIndex: 2, // Charlie plays Plus_Minus
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(-600); // Alice 400 - 1000
        expect(result.players[0].times1000PointsDeducted).toBe(1);
        expect(result.players[2].score).toBe(1000); // Charlie 0 + 1000
        expect(result.previousLeaders).toEqual([expect.objectContaining({ name: 'Alice', score: 400 })]);
      });

      it('Plus_Minus with multiple low leaders can result in negative scores for all', () => {
        const state = makeState({
          players: [
            makePlayer('Alice', { score: 300 }),
            makePlayer('Bob', { score: 300 }),
            makePlayer('Charlie', { score: 100 })
          ],
          currentPlayerIndex: 2, // Charlie plays Plus_Minus
          currentCard: 'Plus_Minus',
        });
        const result = calculateNextTurn(state, 0, true);
        expect(result.players[0].score).toBe(-700); // Alice 300 - 1000
        expect(result.players[1].score).toBe(-700); // Bob 300 - 1000
        expect(result.players[0].times1000PointsDeducted).toBe(1);
        expect(result.players[1].times1000PointsDeducted).toBe(1);
        expect(result.players[2].score).toBe(1100); // Charlie 100 + 1000
        expect(result.previousLeaders).toEqual([
          expect.objectContaining({ name: 'Alice', score: 300 }),
          expect.objectContaining({ name: 'Bob', score: 300 })
        ]);
      });
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

    it('reverts Plus_Minus when multiple leaders were deducted, restores all of them', () => {
      const state = makeState({
        players: [
          makePlayer('Alice', { score: 2000, times1000PointsDeducted: 1 }),
          makePlayer('Bob', { score: 2000, times1000PointsDeducted: 1 }),
          makePlayer('Charlie', { score: 2000, totalTurns: 1, timesPlusMinusCompleted: 1 })
        ],
        currentPlayerIndex: 0, // round 2, undo Charlie's Plus_Minus
        round: 2,
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [
          { name: 'Alice', score: 3000 },
          { name: 'Bob', score: 3000 }
        ],
      });
      const result = calculateUndo(state);
      expect(result.players[0].score).toBe(3000); // Alice restored
      expect(result.players[1].score).toBe(3000); // Bob restored
      expect(result.players[2].score).toBe(1000); // Charlie loses his 1000
      expect(result.players[0].times1000PointsDeducted).toBe(0);
      expect(result.players[1].times1000PointsDeducted).toBe(0);
      expect(result.players[2].timesPlusMinusCompleted).toBe(0);
    });

    it('reverts successful Plus_Minus that did not deduct (card holder was a leader)', () => {
      const state = makeState({
        players: [
          makePlayer('Alice', { score: 3000, totalTurns: 1, timesPlusMinusCompleted: 1 }),
          makePlayer('Bob', { score: 2000 })
        ],
        currentPlayerIndex: 1,
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: null, // No deduction occurred
      });
      const result = calculateUndo(state);
      expect(result.players[0].score).toBe(2000); // Alice loses her 1000
      expect(result.players[1].score).toBe(2000); // Bob untouched
      expect(result.players[0].timesPlusMinusCompleted).toBe(0);
    });

    it('reverts Plus_Minus when leader was taken to negative score', () => {
      const state = makeState({
        players: [
          makePlayer('Alice', { score: -600, times1000PointsDeducted: 1 }),
          makePlayer('Bob', { score: 1000, totalTurns: 1, timesPlusMinusCompleted: 1 })
        ],
        currentPlayerIndex: 0, // round 2, undo Bob's Plus_Minus
        round: 2,
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [{ name: 'Alice', score: 400 }],
      });
      const result = calculateUndo(state);
      expect(result.isRoundEndUndo).toBe(true);
      expect(result.players[0].score).toBe(400); // Alice restored to positive
      expect(result.players[0].times1000PointsDeducted).toBe(0);
      expect(result.players[1].score).toBe(0); // Bob loses his 1000
      expect(result.players[1].timesPlusMinusCompleted).toBe(0);
    });

    it('reverts Plus_Minus with multiple leaders taken to negative', () => {
      const state = makeState({
        players: [
          makePlayer('Alice', { score: -700, times1000PointsDeducted: 1 }),
          makePlayer('Bob', { score: -700, times1000PointsDeducted: 1 }),
          makePlayer('Charlie', { score: 1100, totalTurns: 1, timesPlusMinusCompleted: 1 })
        ],
        currentPlayerIndex: 0, // round 2, undo Charlie's Plus_Minus
        round: 2,
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [
          { name: 'Alice', score: 300 },
          { name: 'Bob', score: 300 }
        ],
      });
      const result = calculateUndo(state);
      expect(result.players[0].score).toBe(300); // Alice restored
      expect(result.players[1].score).toBe(300); // Bob restored
      expect(result.players[2].score).toBe(100); // Charlie loses his 1000
      expect(result.players[0].times1000PointsDeducted).toBe(0);
      expect(result.players[1].times1000PointsDeducted).toBe(0);
      expect(result.players[2].timesPlusMinusCompleted).toBe(0);
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

  // End-to-end sequence: plays two turns in order, then undoes, verifying
  // the deduction and undo chain works correctly for the "leader with less
  // than 1000 points" case the user reported.
  describe('Plus_Minus end-to-end sequence', () => {
    it('beginning of game: leader with 400 pts gets deducted to -600 when another player completes Plus_Minus', () => {
      // Turn 1: Alice plays a 400-card and scores 400.
      const t1 = calculateNextTurn(
        makeState({ currentCard: '400', cards: ['Plus_Minus', '200'], initialCards: { '200': 5, 'Plus_Minus': 1 } }),
        400, true
      );
      expect(t1.players[0].score).toBe(400); // Alice leads
      expect(t1.drawnCard).toBe('Plus_Minus');

      // Turn 2: Bob draws Plus_Minus and completes it.
      const t2 = calculateNextTurn({
        players: t1.players,
        currentPlayerIndex: t1.nextIndex,   // Bob (index 1)
        currentCard: t1.drawnCard,
        round: t1.nextRound,
        winningScore: 6000,
        cards: t1.newDeck,
        initialCards: { '200': 5 },
        previousCard: t1.previousCard,
        previousScore: t1.previousScore,
        previousLeaders: t1.previousLeaders,
      }, 0, true);

      // Alice (400) should now be at -600; Bob should have +1000
      expect(t2.players[0].score).toBe(-600);
      expect(t2.players[0].times1000PointsDeducted).toBe(1);
      expect(t2.players[1].score).toBe(1000);
      expect(t2.previousLeaders).toEqual([expect.objectContaining({ name: 'Alice', score: 400 })]);

      // Undo Turn 2: Alice must be restored to 400, Bob back to 0.
      const u2 = calculateUndo({
        players: t2.players,
        currentPlayerIndex: t2.nextIndex,   // Alice again (index 0), round 2
        currentCard: t2.drawnCard,
        round: t2.nextRound,
        winningScore: 6000,
        cards: t2.newDeck,
        initialCards: { '200': 5 },
        previousCard: t2.previousCard,
        previousScore: t2.previousScore,
        previousLeaders: t2.previousLeaders,
        previousWasBust: t2.previousWasBust,
        previousHighestTurnScore: t2.previousHighestTurnScore,
      });

      expect(u2.players[0].score).toBe(400);  // Alice restored
      expect(u2.players[0].times1000PointsDeducted).toBe(0);
      expect(u2.players[1].score).toBe(0);    // Bob loses his 1000
      expect(u2.players[1].timesPlusMinusCompleted).toBe(0);
    });

    it('both physical dice (nextTurn(0,true)) and digital dice (nextTurn(score,true)) paths produce the same result for Plus_Minus', () => {
      const baseState = makeState({
        players: [makePlayer('Alice', { score: 400 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Plus_Minus',
      });

      // Physical: handleYesNo(true) → nextTurn(0, true)
      const physical = calculateNextTurn(baseState, 0, true);

      // Digital: handleDiceComplete(diceScore, true) → nextTurn(diceScore, true)
      // The engine overrides the dice score to 1000 internally for Plus_Minus.
      const digital = calculateNextTurn(baseState, 750, true);

      expect(physical.players[0].score).toBe(-600);
      expect(digital.players[0].score).toBe(-600);
      expect(physical.players[1].score).toBe(1000);
      expect(digital.players[1].score).toBe(1000);
    });
  });
});
