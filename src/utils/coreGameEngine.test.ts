/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { getLeaders, buildGlobalStatsPayload, shuffleArray, buildDeck, calculateNextTurn, calculateUndo, computeRankedPlayers, hasPlayableDeck } from './coreGameEngine';

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
  describe('hasPlayableDeck', () => {
    it('returns false for undefined, empty, or all-zero decks', () => {
      expect(hasPlayableDeck(undefined)).toBe(false);
      expect(hasPlayableDeck({})).toBe(false);
      expect(hasPlayableDeck({ Stop: 0, Kleeblatt: 0 })).toBe(false);
    });

    it('returns true as soon as any card type has a positive count', () => {
      expect(hasPlayableDeck({ Stop: 0, '200': 1 })).toBe(true);
    });
  });

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
      it('never produces a cluster larger than 3, across many random shuffles', () => {
        // buildDeck draws randomly among still-eligible card types (a type
        // that just finished a run of 3 is ineligible, and a type whose
        // remaining copies would no longer fit is force-placed), so no run can
        // exceed 3 identical adjacent cards — this is a guaranteed invariant,
        // not a probability. Repeating the check many times verifies
        // correctness across different random draws rather than hoping we get
        // lucky.
        const initialCards = {
          '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          'Kniffel': 10, 'Plus_Minus': 5, 'x2': 5,
          'Feuerwerk': 5, 'Kleeblatt': 5, 'Stop': 5
        };

        for (let run = 0; run < 20; run++) {
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
          expect(maxCluster).toBeLessThanOrEqual(3);
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
        // 10 of 15 cards (~67%) is still comfortably enough non-Kniffel cards
        // (5) to keep every run within the MAX_CLUSTER=3 limit — the
        // forced-placement rule enforces that invariant unconditionally, so
        // this is deterministic (this exact case previously slipped through a
        // shuffle-then-patch heuristic about 1 in 5 times).
        const initialCards = { 'Kniffel': 10, '200': 5 };
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
        expect(maxCluster).toBeLessThanOrEqual(3);
      });

      it('still allows clusters of exactly 3 rather than over-smoothing below the limit', () => {
        // MAX_CLUSTER=3 is a ceiling, not a target — the constrained draw should
        // happily produce a run of 3 identical cards when the numbers call for
        // it, not needlessly break things up into smaller runs out of caution.
        // With Kniffel this dominant it reliably forms a run of exactly 3 on
        // essentially every call; looping guards against a one-off tie-break fluke.
        const initialCards = { 'Kniffel': 10, '200': 5 };
        let sawClusterOfThree = false;

        for (let run = 0; run < 10 && !sawClusterOfThree; run++) {
          const deck = buildDeck(initialCards);
          for (let i = 0; i < deck.length && !sawClusterOfThree; i++) {
            let cluster = 1;
            let j = i;
            while (j + 1 < deck.length && deck[j + 1] === deck[j]) { cluster++; j++; }
            if (cluster === 3) sawClusterOfThree = true;
          }
        }

        expect(sawClusterOfThree).toBe(true);
      });

      it('does not front-load the most plentiful card type', () => {
        // A most-plentiful-first greedy would open EVERY deck with the 10-count
        // type; the count-weighted draw makes the first card follow the card
        // distribution instead (P(all 50 openings identical) < 1e-19), so decks
        // must not all start with the same type — mid-game reshuffles used to
        // predictably lead with a burst of the most common card.
        const initialCards = { 'Stop': 10, '200': 5, '300': 5, 'x2': 5 };
        const firstCards = new Set<string>();
        for (let run = 0; run < 50; run++) {
          firstCards.add(buildDeck(initialCards)[0]);
        }
        expect(firstCards.size).toBeGreaterThan(1);
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

      it('terminates with correct counts instead of hanging when no arrangement can satisfy MAX_CLUSTER', () => {
        // One dominant card type with only a single card of another type: no
        // arrangement can keep every run <= 3, so every type eventually becomes
        // "blocked" and the fallback (place the most plentiful type anyway)
        // kicks in. Card counts must still come out correct even though
        // clustering can't be fully resolved.
        const initialCards = { '200': 90, '300': 1 };
        const deck = buildDeck(initialCards);

        expect(deck.length).toBe(91);
        expect(deck.filter(c => c === '200').length).toBe(90);
        expect(deck.filter(c => c === '300').length).toBe(1);
      });

      it('handles many different card types (real game scenario)', () => {
        const initialCards = {
          '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          'Kniffel': 5, 'Plus_Minus': 5, 'x2': 5,
          'Feuerwerk': 5, 'Kleeblatt': 5, 'Stop': 5
        };
        const deck = buildDeck(initialCards);

        // Verify total count and no clusters larger than 3
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
        expect(maxCluster).toBeLessThanOrEqual(3);
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

      const payload = buildGlobalStatsPayload(finalPlayers, 120, true, 7);

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
        isDefaultGame: true,
        totalPlayersSum: 2,
        mostPlayersInGame: 2,
        totalRoundsSum: 7,
        longestGameRounds: 7,
        highestFeuerwerkTurnScore: 0,
        highestX2TurnScore: 0,
        totalTuttos: 0,
        mostCardsInTurn: null,
        highestForfeitedTurnScore: null
      });
    });

    it('reports the player count, round count, and the game-wide highest Feuerwerk/x2 turn scores', () => {
      const finalPlayers = [
        makePlayer('Alice', { highestFeuerwerkTurnScore: 300, highestX2TurnScore: 100 }),
        makePlayer('Bob', { highestFeuerwerkTurnScore: 150, highestX2TurnScore: 600 }),
        makePlayer('Cara', { highestFeuerwerkTurnScore: 0, highestX2TurnScore: 0 })
      ];

      const payload = buildGlobalStatsPayload(finalPlayers, 60, true, 12);

      expect(payload.totalRoundsSum).toBe(12);
      expect(payload.longestGameRounds).toBe(12);
      expect(payload.totalPlayersSum).toBe(3);
      expect(payload.mostPlayersInGame).toBe(3);
      expect(payload.highestFeuerwerkTurnScore).toBe(300);
      expect(payload.highestX2TurnScore).toBe(600);
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

    it('treats non-finite scoreInput (NaN/Infinity) as 0 instead of corrupting the score (regression for ENGINE-BUG-1)', () => {
      // `scoreInput || 0` only catches falsy inputs (0, NaN, ""), so a truthy
      // but non-finite value like Infinity used to flow straight into the
      // player's score unguarded.
      const nanResult = calculateNextTurn(makeState(), NaN, true);
      expect(nanResult.players[0].score).toBe(0);

      const infResult = calculateNextTurn(makeState(), Infinity, true);
      expect(infResult.players[0].score).toBe(0);
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

    it('Kleeblatt success wins the game, clears winningScore, and sets nextIndex null', () => {
      // Both players start at 0 and winningScore defaults to 6000 — the winner's
      // score is set to winningScore, not incremented by the rolled dice score.
      const result = calculateNextTurn(makeState({ currentCard: 'Kleeblatt' }), 0, true);
      expect(result.players[0].score).toBe(6000);
      expect(result.players[0].timesKleeblattCompleted).toBe(1);
      expect(result.isGameOver).toBe(true);
      expect(result.nextIndex).toBeNull();
    });

    it('Kleeblatt success gives the winner strictly more than every other player, even above winningScore', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 5500 }), makePlayer('Bob', { score: 6200 })],
        currentPlayerIndex: 0,
        currentCard: 'Kleeblatt',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.players[0].score).toBe(6201); // Bob's 6200 + 1, not the 6000 floor
      expect(result.players[0].score).toBeGreaterThan(result.players[1].score);
    });

    it('Kleeblatt success never lowers the winner\'s own score', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 7000 }), makePlayer('Bob', { score: 100 })],
        currentPlayerIndex: 0,
        currentCard: 'Kleeblatt',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.players[0].score).toBe(7000); // kept, not reset down to winningScore
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
          previousPlayerName: 'Bob',
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

    it('records the highest Feuerwerk turn score', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Feuerwerk' }), 800, true);
      expect(result.players[0].highestFeuerwerkTurnScore).toBe(800);
    });

    it('records the highest x2 turn score', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'x2' }), 900, true);
      expect(result.players[0].highestX2TurnScore).toBe(900);
    });

    it('does not update highestFeuerwerkTurnScore/highestX2TurnScore for unrelated card types', () => {
      const result = calculateNextTurn(makeState({ currentCard: '200' }), 200, true);
      expect(result.players[0].highestFeuerwerkTurnScore).toBeUndefined();
      expect(result.players[0].highestX2TurnScore).toBeUndefined();
    });

    it('keeps the higher of two Feuerwerk turn scores rather than overwriting with a lower one', () => {
      const state = makeState({
        currentCard: 'Feuerwerk',
        players: [makePlayer('Alice', { highestFeuerwerkTurnScore: 500 }), makePlayer('Bob')],
      });
      const result = calculateNextTurn(state, 300, true);
      expect(result.players[0].highestFeuerwerkTurnScore).toBe(500);
    });

    it('keeps the higher of two x2 turn scores rather than overwriting with a lower one', () => {
      const state = makeState({
        currentCard: 'x2',
        players: [makePlayer('Alice', { highestX2TurnScore: 600 }), makePlayer('Bob')],
      });
      const result = calculateNextTurn(state, 250, true);
      expect(result.players[0].highestX2TurnScore).toBe(600);
    });

    // Deliberate design choice: highestFeuerwerkTurnScore/highestX2TurnScore
    // update on turnScore alone, the same way the card-agnostic
    // highestTurnScore already does (see the block above it in
    // calculateNextTurn) — neither is gated on `wasBust`. A future refactor
    // that "fixes" this by adding a bust gate would silently change behavior,
    // so it's pinned down here explicitly.
    it('still records a Feuerwerk/x2 turn score even when the turn is a bust', () => {
      const feuerwerkResult = calculateNextTurn(makeState({ currentCard: 'Feuerwerk' }), 450, false);
      expect(feuerwerkResult.players[0].feuerwerkBusts).toBe(1);
      expect(feuerwerkResult.players[0].highestFeuerwerkTurnScore).toBe(450);

      const x2Result = calculateNextTurn(makeState({ currentCard: 'x2' }), 550, false);
      expect(x2Result.players[0].x2Busts).toBe(1);
      expect(x2Result.players[0].highestX2TurnScore).toBe(550);
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

    it('returns null (never corrupts a different player) when the player who took the previous turn is no longer in the roster', () => {
      // Bug: a non-active player who took the immediately-preceding turn could
      // be removed (leave/kick/reconnect-timeout) without clearing previous*
      // bookkeeping. Undo used to compute the previous player as
      // "currentPlayerIndex - 1" against the CURRENT (shrunk) roster, so it
      // silently landed on and corrupted whoever now occupies that slot instead
      // of refusing. With Bob (who played the previous turn) gone, only Alice
      // and Charlie remain; Charlie is now at index 1 — "index - 1" arithmetic
      // would wrongly target Alice.
      const state = makeState({
        players: [makePlayer('Alice'), makePlayer('Charlie', { score: 500, totalTurns: 1 })],
        currentPlayerIndex: 1, // Charlie's turn; Bob (removed) played before them
        previousCard: '200',
        previousScore: 500,
        previousPlayerName: 'Bob',
      });
      expect(calculateUndo(state)).toBeNull();
    });

    it('finds the previous player by name even when the roster shifted around them (removal before their seat)', () => {
      // Original order was [Zoe, Alice, Bob]; Zoe (idx 0) left, shifting Alice to
      // idx 0 and Bob to idx 1. Alice — still present — took the previous turn
      // and must be found by name at her NEW index, not by "currentPlayerIndex - 1".
      const state = makeState({
        players: [makePlayer('Alice', { score: 300, totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1, // Bob's turn now
        previousCard: '200',
        previousScore: 300,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result).not.toBeNull();
      expect(result.nextIndex).toBe(0);
      expect(result.players[0].score).toBe(0);
      expect(result.players[0].totalTurns).toBe(0);
    });

    it('reverts score, turn ownership, totalTurns and busts', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 0, totalTurns: 1, busts: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Stop',
        previousCard: '200',
        previousScore: 0,
        previousWasBust: true,
        previousPlayerName: 'Alice',
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
        previousPlayerName: 'Alice',
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
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].x2PointsScored).toBe(0);
      expect(result.players[0].timesx2Received).toBe(0);
      expect(result.players[0].score).toBe(0);
    });

    it('reverses an x2 BUST — decrements busts and x2Busts alongside the other x2 counters', () => {
      // The test above only covers undoing a *successful* x2 turn (previousWasBust:
      // false). A bust also increments the generic `busts` counter and the x2-specific
      // `x2Busts` counter (coreGameEngine.ts: wasBust branch), so undo must reverse
      // those too, not just timesx2Received/x2PointsScored.
      const state = makeState({
        players: [makePlayer('Alice', {
          score: 0, totalTurns: 1, timesx2Received: 1, x2PointsScored: 0,
          busts: 1, x2Busts: 1,
        }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'x2',
        previousScore: 0,
        previousWasBust: true,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].busts).toBe(0);
      expect(result.players[0].x2Busts).toBe(0);
      expect(result.players[0].timesx2Received).toBe(0);
      expect(result.players[0].x2PointsScored).toBe(0);
      expect(result.players[0].totalTurns).toBe(0);
    });

    it('only touches Feuerwerk stats based on previousCard, not currentCard (Bug 2)', () => {
      // Previous player played '200'; the card now showing is Feuerwerk.
      const state = makeState({
        players: [makePlayer('Alice', { score: 300, totalTurns: 1, timesFeuerwerkReceived: 0 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: 'Feuerwerk',
        previousCard: '200',
        previousScore: 300,
        previousPlayerName: 'Alice',
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
        previousPlayerName: 'Bob',
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
        previousPlayerName: 'Charlie',
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
        previousPlayerName: 'Alice',
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
        previousPlayerName: 'Bob',
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
        previousPlayerName: 'Charlie',
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
        previousPlayerName: 'Alice',
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
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.newDeck).toEqual(['Stop', '600']);
      expect(result.drawnCard).toBe('200');
    });

    it('does not inject null into newDeck when undoing while currentCard is null (regression for ENGINE-BUG-5)', () => {
      // currentCard can be null (e.g. a momentarily exhausted deck) without the
      // game being finished — `[currentCard as CardType, ...cards]` used to cast
      // right past that null and push it into the deck array.
      const state = makeState({
        players: [makePlayer('Alice', { score: 500, totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        currentCard: null,
        cards: ['200', '600'],
        previousCard: '200',
        previousScore: 500,
        previousPlayerName: 'Alice',
        finished: false,
      });
      const result = calculateUndo(state);
      expect(result.newDeck).toEqual(['200', '600']);
      expect(result.newDeck).not.toContain(null);
    });

    it('returns null when undoing on round 1, player 0', () => {
      const state = makeState({
        players: [makePlayer('Alice', { totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 0,
        round: 1,
        previousCard: '200',
        previousScore: 0,
        previousPlayerName: 'Bob',
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
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].highestTurnScore).toBe(1000);
    });

    it('restores highestFeuerwerkTurnScore and highestX2TurnScore', () => {
      const state = makeState({
        players: [
          makePlayer('Alice', { highestFeuerwerkTurnScore: 900, highestX2TurnScore: 700 }),
          makePlayer('Bob'),
        ],
        currentPlayerIndex: 1,
        previousCard: 'Feuerwerk',
        previousScore: 300,
        previousHighestFeuerwerkTurnScore: 600,
        previousHighestX2TurnScore: 700,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].highestFeuerwerkTurnScore).toBe(600);
      expect(result.players[0].highestX2TurnScore).toBe(700);
    });

    it('reverses Kleeblatt failure', () => {
      const state = makeState({
        players: [makePlayer('Alice', { timesKleeblattFailed: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Kleeblatt',
        previousScore: 0,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesKleeblattFailed).toBe(0);
    });

    it('returns null after a Kleeblatt win — the instant game-over cannot be undone', () => {
      // A real Kleeblatt completion ends the game: calculateNextTurn returns
      // isGameOver with nextIndex null, and the store sets finished=true and
      // currentPlayerIndex=null. Undo must refuse this state — the winner's
      // score was SET to a computed value (not incremented), so an additive
      // undo would corrupt it.
      const win = calculateNextTurn(
        makeState({ currentCard: 'Kleeblatt' }),
        0,
        true,
      );
      expect(win.isGameOver).toBe(true);

      const result = calculateUndo(makeState({
        players: win.players,
        currentPlayerIndex: win.nextIndex, // null
        currentCard: null,
        previousCard: win.previousCard,
        previousScore: win.previousScore,
        previousPlayerName: win.previousPlayerName,
        finished: true,
      }));
      expect(result).toBeNull();
    });

    it('returns null when the game is finished, regardless of other fields', () => {
      const state = makeState({
        previousCard: '200',
        previousScore: 300,
        finished: true,
      });
      expect(calculateUndo(state)).toBeNull();
    });

    it('decrements timesKniffelCompleted when undoing a successful Kniffel (previousScore 2000)', () => {
      const state = makeState({
        players: [makePlayer('Alice', { timesKniffelCompleted: 1, score: 2000, totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesKniffelCompleted).toBe(0);
      expect(result.players[0].timesKniffelFailed).toBe(0);
      expect(result.players[0].score).toBe(0);
    });

    it('decrements timesKniffelFailed when undoing a failed Kniffel', () => {
      const state = makeState({
        players: [makePlayer('Alice', { timesKniffelFailed: 1, totalTurns: 1 }), makePlayer('Bob')],
        currentPlayerIndex: 1,
        previousCard: 'Kniffel',
        previousScore: 0,
        previousPlayerName: 'Alice',
      });
      const result = calculateUndo(state);
      expect(result.players[0].timesKniffelFailed).toBe(0);
      expect(result.players[0].timesKniffelCompleted).toBe(0);
      expect(result.players[0].score).toBe(0);
    });

    // A special card's outcome used to be re-derived from previousScore
    // (=== the card's fixed value means "completed"). That reading is wrong
    // for a FAILED card whose turn happened to be worth exactly that value:
    // the already-zero completed counter was decremented (clamped, so a
    // no-op) and the failure stayed recorded forever. calculateNextTurn
    // records the outcome now, so undo reads it instead of guessing.
    describe('the previous turn\'s outcome is read, not inferred from its score', () => {
      it('reverses a FAILED Plus_Minus whose turn scored exactly PLUS_MINUS_SCORE as a failure', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 1000, totalTurns: 1, timesPlusMinusFailed: 1 }), makePlayer('Bob')],
          currentPlayerIndex: 1,
          previousCard: 'Plus_Minus',
          previousScore: 1000,
          previousWasSuccess: false,
          previousPlayerName: 'Alice',
        });
        const result = calculateUndo(state);
        expect(result.players[0].timesPlusMinusFailed).toBe(0);
        expect(result.players[0].timesPlusMinusCompleted).toBe(0);
      });

      it('reverses a FAILED Kniffel whose turn scored exactly KNIFFEL_SCORE as a failure', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 2000, totalTurns: 1, timesKniffelFailed: 1 }), makePlayer('Bob')],
          currentPlayerIndex: 1,
          previousCard: 'Kniffel',
          previousScore: 2000,
          previousWasSuccess: false,
          previousPlayerName: 'Alice',
        });
        const result = calculateUndo(state);
        expect(result.players[0].timesKniffelFailed).toBe(0);
        expect(result.players[0].timesKniffelCompleted).toBe(0);
      });

      it('still reverses a COMPLETED one as a completion', () => {
        const state = makeState({
          players: [makePlayer('Alice', { score: 1000, totalTurns: 1, timesPlusMinusCompleted: 1 }), makePlayer('Bob')],
          currentPlayerIndex: 1,
          previousCard: 'Plus_Minus',
          previousScore: 1000,
          previousWasSuccess: true,
          previousPlayerName: 'Alice',
        });
        const result = calculateUndo(state);
        expect(result.players[0].timesPlusMinusCompleted).toBe(0);
        expect(result.players[0].timesPlusMinusFailed).toBe(0);
      });

      it('falls back to the score comparison for a save/push predating the recorded outcome', () => {
        // No previousWasSuccess at all — the only thing that distinguishes an
        // old entry from a recorded `false`. Those were committed under the
        // score comparison, so that is what reverses them.
        const state = makeState({
          players: [makePlayer('Alice', { score: 2000, totalTurns: 1, timesKniffelCompleted: 1 }), makePlayer('Bob')],
          currentPlayerIndex: 1,
          previousCard: 'Kniffel',
          previousScore: 2000,
          previousPlayerName: 'Alice',
        });
        const result = calculateUndo(state);
        expect(result.players[0].timesKniffelCompleted).toBe(0);
        expect(result.players[0].timesKniffelFailed).toBe(0);
      });
    });
  });

  describe('calculateNextTurn records the turn outcome for undo', () => {
    it('reports success for a completed special card', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Plus_Minus' }), 0, true);
      expect(result.previousWasSuccess).toBe(true);
    });

    it('reports failure for a failed one, whatever score it was committed with', () => {
      const result = calculateNextTurn(makeState({ currentCard: 'Plus_Minus' }), 1000, false);
      expect(result.previousWasSuccess).toBe(false);
    });

    it('reports the outcome of a classic chain too', () => {
      const summary = { cards: [{ card: '200', completed: true }], tuttoCount: 1, plusMinusSuccesses: 0, ended: 'banked' };
      const result = calculateNextTurn(makeState({ currentCard: '200' }), 500, true, summary);
      expect(result.previousWasSuccess).toBe(true);
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
        previousPlayerName: t2.previousPlayerName,
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

  describe('History Log Entry Generation', () => {
    it('generates a correct historyEntry for a Stop card (skip)', () => {
      const state = makeState({ currentCard: 'Stop' });
      const result = calculateNextTurn(state, 0, false);
      expect(result.historyEntry).toBeDefined();
      expect(result.historyEntry.type).toBe('skip');
      expect(result.historyEntry.playerName).toBe('Alice');
      expect(result.historyEntry.card).toBe('Stop');
      expect(result.historyEntry.score).toBe(0);
      expect(result.historyEntry.round).toBe(1);
      expect(result.historyEntry.id).toBe('1-Alice-1');
    });

    it('generates a correct historyEntry for a bust', () => {
      const state = makeState({ currentCard: 'x2' });
      const result = calculateNextTurn(state, 0, false);
      expect(result.historyEntry.type).toBe('bust');
      expect(result.historyEntry.playerName).toBe('Alice');
      expect(result.historyEntry.card).toBe('x2');
      expect(result.historyEntry.score).toBe(0);
    });

    it('generates a correct historyEntry for a successful turn', () => {
      const state = makeState({ currentCard: '300' });
      const result = calculateNextTurn(state, 500, true);
      expect(result.historyEntry.type).toBe('success');
      expect(result.historyEntry.playerName).toBe('Alice');
      expect(result.historyEntry.card).toBe('300');
      expect(result.historyEntry.score).toBe(500);
    });

    it('generates deductedPlayers when Plus_Minus resolves and player is not the leader', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 400 }), makePlayer('Bob', { score: 0 })],
        currentPlayerIndex: 1, // Bob
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.historyEntry.type).toBe('success');
      expect(result.historyEntry.playerName).toBe('Bob');
      expect(result.historyEntry.score).toBe(1000);
      expect(result.historyEntry.deductedPlayers).toEqual(['Alice']);
    });

    it('does not generate deductedPlayers when Plus_Minus resolves and player is already the leader', () => {
      const state = makeState({
        players: [makePlayer('Alice', { score: 400 }), makePlayer('Bob', { score: 0 })],
        currentPlayerIndex: 0, // Alice (leader)
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(state, 0, true);
      expect(result.historyEntry.type).toBe('success');
      expect(result.historyEntry.playerName).toBe('Alice');
      expect(result.historyEntry.score).toBe(1000);
      expect(result.historyEntry.deductedPlayers).toBeUndefined();
    });

    it('generates a correct historyEntry for Kniffel success and failure', () => {
      const stateSuccess = makeState({ currentCard: 'Kniffel' });
      const resultSuccess = calculateNextTurn(stateSuccess, 0, true);
      expect(resultSuccess.historyEntry.type).toBe('success');
      expect(resultSuccess.historyEntry.score).toBe(2000);

      const stateFail = makeState({ currentCard: 'Kniffel' });
      const resultFail = calculateNextTurn(stateFail, 0, false);
      expect(resultFail.historyEntry.type).toBe('fail');
      expect(resultFail.historyEntry.score).toBe(0);
    });

    it('generates a correct historyEntry for Kleeblatt success and failure', () => {
      const stateSuccess = makeState({ currentCard: 'Kleeblatt' });
      const resultSuccess = calculateNextTurn(stateSuccess, 0, true);
      expect(resultSuccess.historyEntry.type).toBe('success');
      expect(resultSuccess.historyEntry.score).toBe(0);

      const stateFail = makeState({ currentCard: 'Kleeblatt' });
      const resultFail = calculateNextTurn(stateFail, 0, false);
      expect(resultFail.historyEntry.type).toBe('fail');
      expect(resultFail.historyEntry.score).toBe(0);
    });
  });

  describe('classic turn summaries (calculateNextTurn with turnSummary)', () => {
    const summary = (overrides = {}) => ({
      cards: [{ card: '300', completed: true }],
      tuttoCount: 1,
      plusMinusSuccesses: 0,
      ended: 'banked',
      ...overrides,
    });

    it('takes the client-computed score verbatim and owns per-card counters', () => {
      // Chain: 300 bonus (tutto) → Kniffel (straight) → banked. The client
      // computed 300+dice+2000 = 2800; the engine must not add anything.
      const result = calculateNextTurn(
        makeState({ currentCard: 'Kniffel' }),
        2800, true,
        summary({
          cards: [{ card: '300', completed: true }, { card: 'Kniffel', completed: true }],
          tuttoCount: 2,
        }),
      );
      const alice = result.players[0];
      expect(alice.score).toBe(2800);
      expect(alice.timesKniffelCompleted).toBe(1);
      expect(alice.totalTurns).toBe(1);
      expect(alice.busts).toBe(0);
      expect(result.historyEntry.type).toBe('success');
      expect(result.historyEntry.card).toBe('300');           // first chain card
      expect(result.historyEntry.cards).toEqual(['300', 'Kniffel']);
      expect(result.historyEntry.score).toBe(2800);
      expect(result.previousTurnSummary).toMatchObject({ tuttoCount: 2, ended: 'banked' });
    });

    it('a null forfeits everything: score 0, one bust, per-card counters still recorded', () => {
      const result = calculateNextTurn(
        makeState({ currentCard: 'x2' }),
        0, false,
        summary({
          cards: [{ card: '600', completed: true }, { card: 'x2', completed: false }],
          ended: 'null',
        }),
      );
      const alice = result.players[0];
      expect(alice.score).toBe(0);
      expect(alice.busts).toBe(1);
      expect(alice.timesx2Received).toBe(1);
      // No per-card bust attribution in classic:
      expect(alice.x2Busts).toBe(0);
      expect(result.historyEntry.type).toBe('bust');
      expect(result.historyEntry.cards).toEqual(['600', 'x2']);
    });

    it('a chain-ending Stop card is a forfeit (type bust), counted as skipped but not as a dice bust', () => {
      const result = calculateNextTurn(
        makeState({ currentCard: 'Stop' }),
        0, false,
        summary({
          cards: [{ card: '400', completed: true }, { card: 'Stop', completed: false }],
          ended: 'stopCard',
        }),
      );
      const alice = result.players[0];
      expect(alice.timesSkipped).toBe(1);
      expect(alice.busts).toBe(0);
      expect(result.historyEntry.type).toBe('bust');
      expect(result.previousTurnSummary?.ended).toBe('stopCard');
    });

    it('atomic Plus/Minus: deductions apply only when the turn banks, once per success, clamped at 0', () => {
      // Bob leads with 1500; Alice banks a chain containing two successful
      // Plus/Minus cards. Bob is deducted twice, but never below 0.
      const state = makeState({
        players: [makePlayer('Alice'), makePlayer('Bob', { score: 1500 })],
        currentCard: 'Plus_Minus',
      });
      const result = calculateNextTurn(
        state, 2000, true,
        summary({
          cards: [{ card: 'Plus_Minus', completed: true }, { card: 'Plus_Minus', completed: true }],
          tuttoCount: 2,
          plusMinusSuccesses: 2,
        }),
      );
      const [alice, bob] = result.players;
      expect(alice.score).toBe(2000);
      expect(alice.timesPlusMinusCompleted).toBe(2);
      expect(bob.score).toBe(0);                       // 1500 → 500 → clamped 0
      expect(bob.times1000PointsDeducted).toBe(2);
      expect(result.historyEntry.deductedPlayers).toEqual(['Bob', 'Bob']);
      expect(result.previousLeaders).toEqual([expect.objectContaining({ name: 'Bob', score: 1500 })]);
      expect(result.previousTurnSummary?.deductedPlayers).toEqual(['Bob', 'Bob']);
    });

    it('atomic Plus/Minus: a forfeited chain never deducts, even with successes recorded', () => {
      const state = makeState({
        players: [makePlayer('Alice'), makePlayer('Bob', { score: 1500 })],
        currentCard: '200',
      });
      const result = calculateNextTurn(
        state, 0, false,
        summary({
          cards: [{ card: 'Plus_Minus', completed: true }, { card: '200', completed: false }],
          tuttoCount: 1,
          plusMinusSuccesses: 1,
          ended: 'null',
        }),
      );
      expect(result.players[1].score).toBe(1500);
      expect(result.players[1].times1000PointsDeducted).toBe(0);
      expect(result.players[0].timesPlusMinusCompleted).toBe(1); // the card WAS completed
      expect(result.players[0].busts).toBe(1);
    });

    it('tracks the chain records: totalTuttos, mostCardsInTurn, highestForfeitedTurnScore', () => {
      const win = calculateNextTurn(
        makeState({ currentCard: 'x2' }), 1000, true,
        summary({ cards: [{ card: '300', completed: true }, { card: 'x2', completed: true }], tuttoCount: 2 }),
      );
      expect(win.players[0].totalTuttos).toBe(2);
      expect(win.players[0].mostCardsInTurn).toBe(2);
      expect(win.players[0].highestForfeitedTurnScore).toBeUndefined();

      const lost = calculateNextTurn(
        makeState({ currentCard: '200' }), 0, false,
        summary({ cards: [{ card: '200', completed: false }], tuttoCount: 1, ended: 'null', forfeitedScore: 850 }),
      );
      expect(lost.players[0].highestForfeitedTurnScore).toBe(850);
      expect(lost.previousTurnSummary?.prevHighestForfeitedTurnScore).toBeNull();
      expect(lost.previousTurnSummary?.prevMostCardsInTurn).toBeNull();
    });

    it('does not track per-card turn records (highest Feuerwerk/x2 turn) for classic turns', () => {
      const result = calculateNextTurn(
        makeState({ currentCard: 'Feuerwerk' }),
        900, true,
        summary({ cards: [{ card: 'Feuerwerk', completed: true }] }),
      );
      const alice = result.players[0];
      expect(alice.highestTurnScore).toBe(900);
      expect(alice.highestFeuerwerkTurnScore ?? 0).toBe(0);
      expect(alice.feuerwerkPointsScored).toBe(0);
      expect(alice.timesFeuerwerkReceived).toBe(1);
    });

    it('a Kleeblatt completed in a chain still wins the game instantly', () => {
      const result = calculateNextTurn(
        makeState({ currentCard: 'Kleeblatt' }),
        1200, true,
        summary({
          cards: [{ card: '300', completed: true }, { card: 'Kleeblatt', completed: true }],
          tuttoCount: 3,
        }),
      );
      expect(result.isGameOver).toBe(true);
      expect(result.players[0].timesKleeblattCompleted).toBe(1); // once, not twice
      expect(result.historyEntry.cards).toEqual(['300', 'Kleeblatt']);
    });

    describe('undo of a classic chain', () => {
      const playChain = () => {
        const state = makeState({
          players: [makePlayer('Alice'), makePlayer('Bob', { score: 1500 })],
          currentCard: 'Kniffel',
          cards: ['400', '500'],
        });
        const result = calculateNextTurn(
          state, 3600, true,
          summary({
            cards: [
              { card: 'Plus_Minus', completed: true },
              { card: '600', completed: true },
              { card: 'Kniffel', completed: true },
            ],
            tuttoCount: 3,
            plusMinusSuccesses: 1,
          }),
        );
        return { state, result };
      };

      const stateAfter = (result) => ({
        players: result.players,
        currentPlayerIndex: result.nextIndex,
        round: result.nextRound,
        currentCard: result.drawnCard,
        cards: result.newDeck,
        winningScore: 6000,
        initialCards: { '200': 5 },
        previousCard: result.previousCard,
        previousScore: result.previousScore,
        previousLeaders: result.previousLeaders,
        previousWasBust: result.previousWasBust,
        previousHighestTurnScore: result.previousHighestTurnScore,
        previousHighestFeuerwerkTurnScore: result.previousHighestFeuerwerkTurnScore,
        previousHighestX2TurnScore: result.previousHighestX2TurnScore,
        previousPlayerName: result.previousPlayerName,
        previousTurnSummary: result.previousTurnSummary,
        finished: false,
      });

      it('restores every chain card to the deck in replay order and reverses all counters', () => {
        const { result } = playChain();
        const undo = calculateUndo(stateAfter(result));
        expect(undo).not.toBeNull();
        // Replay order: first chain card re-dealt, remaining chain cards on
        // top of the deck, then the next player's card, then the rest.
        expect(undo.drawnCard).toBe('Plus_Minus');
        expect(undo.newDeck).toEqual(['600', 'Kniffel', result.drawnCard, ...result.newDeck]);

        const alice = undo.players[0];
        const bob = undo.players[1];
        expect(alice.score).toBe(0);
        expect(alice.totalTurns).toBe(0);
        expect(alice.timesKniffelCompleted).toBe(0);
        expect(alice.timesPlusMinusCompleted).toBe(0);
        expect(alice.totalTuttos).toBe(0);
        expect(alice.mostCardsInTurn).toBeUndefined();
        expect(bob.score).toBe(1500);
        expect(bob.times1000PointsDeducted).toBe(0);
      });

      it('a chain that ended on a drawn Stop card IS undoable, a bare Stop is not', () => {
        const chainedStop = calculateNextTurn(
          makeState({ currentCard: 'Stop' }),
          0, false,
          summary({ cards: [{ card: '400', completed: true }, { card: 'Stop', completed: false }], ended: 'stopCard' }),
        );
        const undoable = calculateUndo(stateAfter(chainedStop));
        expect(undoable).not.toBeNull();
        expect(undoable.players[0].timesSkipped).toBe(0);
        expect(undoable.drawnCard).toBe('400');

        const bareStop = calculateNextTurn(makeState({ currentCard: 'Stop' }), 0, false);
        expect(calculateUndo(stateAfter(bareStop))).toBeNull();
      });

      it('a forfeited chain undo reverses the bust counter', () => {
        const busted = calculateNextTurn(
          makeState({ currentCard: '200' }),
          0, false,
          summary({ cards: [{ card: '200', completed: false }], tuttoCount: 0, ended: 'null' }),
        );
        expect(busted.players[0].busts).toBe(1);
        const undo = calculateUndo(stateAfter(busted));
        expect(undo.players[0].busts).toBe(0);
      });
    });
  });
});
