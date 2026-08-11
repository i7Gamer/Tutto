import type {
  CardType,
  InitialCards,
  Player,
  CoreGameState,
  GlobalStatsPayload,
  NextTurnResult,
  UndoResult,
  HistoryEntry,
  HistoryEventType,
  TurnSummary,
} from '../types';
import { isSpecialCard } from './diceTurnControls';

// Awarded turn score for successfully completing these Yes/No cards — not
// incremental dice points, a fixed value the card itself defines. Exported
// because the classic chain path computes the turn total client-side
// (DiceGame) and must use the exact same values the engine awards.
export const PLUS_MINUS_SCORE = 1000;
export const KNIFFEL_SCORE = 2000;

// A deck with every card type at 0 leaves currentCard permanently null and the
// game unplayable — both lobbies must refuse to start in that state.
export const hasPlayableDeck = (initialCards: InitialCards | undefined): boolean =>
  Object.values(initialCards ?? {}).some(count => (count ?? 0) > 0);

/**
 * The previous-turn bookkeeping in its "there is nothing to undo" state.
 *
 * These ten fields all describe the same single turn, so they move together:
 * calculateNextTurn fills them in as one set, calculateUndo consumes them as
 * one set, and every site that ends or discards a turn clears them as one set.
 * Written out once because there are five such sites across the client store
 * and the server room state, and clearing some but not all leaves a
 * half-erased turn — which is what server/rooms.ts's active-player removal did,
 * keeping a previousTurnSummary for a turn whose card and player it had just
 * dropped. Inert, since undo refuses without previousCard, but it rode every
 * subsequent broadcast.
 *
 * A factory, not a shared literal: the result lands in mutable store state and
 * in the server's room state (see createInitialLocalState for the same reason).
 *
 * `satisfies` rather than a return-type annotation, the same way
 * playerStats.ts checks its own field set: the annotation would widen
 * previousLeaders to Player[] | null, which the server's stricter
 * ServerPlayer[] | null then refuses — while every key is still checked
 * against CoreGameState, so a field added there fails to compile here.
 */
export const noUndoableTurn = () => ({
  previousCard: null,
  previousScore: null,
  previousLeaders: null,
  previousWasBust: false,
  // undefined, not false: the field holds "the outcome that was recorded, if
  // one was", and there is no turn here to have recorded anything. That is the
  // same value an entry predating the field carries, which is what
  // calculateUndo's compatibility fallback keys off — and it drops out of
  // JSON.stringify, so a save written now looks like one written then.
  previousWasSuccess: undefined,
  previousHighestTurnScore: 0,
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: null,
  previousTurnSummary: null,
} satisfies Partial<CoreGameState>);

export const shuffleArray = <T>(array: T[]): T[] => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

// Clusters of up to MAX_CLUSTER identical adjacent cards are acceptable; only
// runs longer than that are avoided.
const MAX_CLUSTER = 3;

// Builds the deck as a uniform random shuffle constrained to "no more than
// MAX_CLUSTER identical cards adjacent": each card is drawn randomly among the
// still-eligible types, weighted by remaining copies (sampling without
// replacement), with two interventions:
//   - a type that just completed a run of MAX_CLUSTER is ineligible for the
//     next slot (that's the constraint itself), and
//   - a type whose remaining copies no longer fit into the runs the other
//     remaining cards can separate (count > MAX_CLUSTER * othersLeft) MUST be
//     placed now — deferring it once more would force an over-long run later.
//     At most one type can ever be in this state (two would need more cards
//     than remain), so the rule is unambiguous. A pure most-plentiful-first
//     greedy also satisfies the constraint but deterministically front-loads
//     the most common card type, which is why it isn't used here.
// If a card type so dominates the deck that MAX_CLUSTER is mathematically
// unsatisfiable (e.g. one type outnumbering all others combined), every type
// eventually becomes ineligible and we fall back to placing the blocked one
// anyway rather than getting stuck.
export const buildDeck = (initialCards: InitialCards): CardType[] => {
  const remaining = new Map<CardType, number>();
  (Object.keys(initialCards) as CardType[]).forEach(cardType => {
    const count = initialCards[cardType] ?? 0;
    if (count > 0) remaining.set(cardType, count);
  });

  const deckSize = Array.from(remaining.values()).reduce((sum, c) => sum + c, 0);
  let remainingTotal = deckSize;
  const deck: CardType[] = [];
  let lastCard: CardType | null = null;
  let runLength = 0;

  while (deck.length < deckSize) {
    const blocked: CardType | null = runLength >= MAX_CLUSTER ? lastCard : null;
    let candidates: [CardType, number][] = Array.from(remaining.entries()).filter(([type, count]) => count > 0 && type !== blocked);
    if (candidates.length === 0) candidates = Array.from(remaining.entries()).filter(([, count]) => count > 0);

    const forced = candidates.find(([, count]) => count > MAX_CLUSTER * (remainingTotal - count));

    let chosen: CardType;
    if (forced) {
      chosen = forced[0];
    } else {
      const candidateTotal = candidates.reduce((sum, [, count]) => sum + count, 0);
      let pick = Math.floor(Math.random() * candidateTotal);
      chosen = candidates[candidates.length - 1][0];
      for (const [type, count] of candidates) {
        pick -= count;
        if (pick < 0) { chosen = type; break; }
      }
    }

    deck.push(chosen);
    remaining.set(chosen, (remaining.get(chosen) ?? 0) - 1);
    remainingTotal--;
    runLength = chosen === lastCard ? runLength + 1 : 1;
    lastCard = chosen;
  }

  return deck;
};

export const computeRankedPlayers = (players: Player[]): Player[] => {
  const sorted = [...players].map(p => ({ ...p })).sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    if (i > 0 && p.score === sorted[i - 1].score) {
      p.position = sorted[i - 1].position;
    } else {
      p.position = i + 1;
    }
  });
  return sorted;
};

export const getLeaders = (players: Player[]): Player[] => {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return [];
  const topScore = sorted[0].score;
  return sorted.filter(p => p.score === topScore);
};

export const buildGlobalStatsPayload = (
  finalPlayers: Player[],
  finalTime: number,
  isDefaultGame: boolean,
  finalRound: number,
): GlobalStatsPayload => {
  let totalPlusMinus = 0;
  let totalKniffel = 0;
  let totalStop = 0;
  let totalFeuerwerk = 0;
  let totalKleeblatt = 0;
  let totalKleeblattCompleted = 0;
  let totalx2 = 0;
  let totalTurns = 0;
  let totalScore = 0;
  let totalPlusMinusCompleted = 0;
  let totalKniffelCompleted = 0;
  let totalFeuerwerkPoints = 0;
  let totalx2Points = 0;
  let totalFeuerwerkBusts = 0;
  let totalx2Busts = 0;
  let totalBusts = 0;
  let totalTuttos = 0;
  let highestTurnScore = 0;
  let highestFeuerwerkTurnScore = 0;
  let highestX2TurnScore = 0;
  let mostCardsInTurn: number | null = null;
  let highestForfeitedTurnScore: number | null = null;
  let fastestWinTurns: number | null = null;
  let fastestLossTurns: number | null = null;

  const leaders = getLeaders(finalPlayers);
  const isWinner = (p: Player) => leaders.some(l => l.name === p.name);

  finalPlayers.forEach(p => {
    totalPlusMinus += ((p.timesPlusMinusCompleted ?? 0) + (p.timesPlusMinusFailed ?? 0));
    totalKniffel += ((p.timesKniffelCompleted ?? 0) + (p.timesKniffelFailed ?? 0));
    totalStop += (p.timesSkipped ?? 0);
    totalFeuerwerk += (p.timesFeuerwerkReceived ?? 0);
    totalKleeblatt += ((p.timesKleeblattFailed ?? 0) + (p.timesKleeblattCompleted ?? 0));
    totalKleeblattCompleted += (p.timesKleeblattCompleted ?? 0);
    totalx2 += (p.timesx2Received ?? 0);
    totalTurns += (p.totalTurns ?? 0);
    totalScore += (p.score ?? 0);
    totalPlusMinusCompleted += (p.timesPlusMinusCompleted ?? 0);
    totalKniffelCompleted += (p.timesKniffelCompleted ?? 0);
    totalFeuerwerkPoints += (p.feuerwerkPointsScored ?? 0);
    totalx2Points += (p.x2PointsScored ?? 0);
    totalFeuerwerkBusts += (p.feuerwerkBusts ?? 0);
    totalx2Busts += (p.x2Busts ?? 0);
    totalBusts += (p.busts ?? 0);
    totalTuttos += (p.totalTuttos ?? 0);
    if (p.mostCardsInTurn !== undefined && (mostCardsInTurn === null || p.mostCardsInTurn > mostCardsInTurn)) {
      mostCardsInTurn = p.mostCardsInTurn;
    }
    if (p.highestForfeitedTurnScore !== undefined && (highestForfeitedTurnScore === null || p.highestForfeitedTurnScore > highestForfeitedTurnScore)) {
      highestForfeitedTurnScore = p.highestForfeitedTurnScore;
    }
    if ((p.highestTurnScore ?? 0) > highestTurnScore) {
      highestTurnScore = p.highestTurnScore ?? 0;
    }
    if ((p.highestFeuerwerkTurnScore ?? 0) > highestFeuerwerkTurnScore) {
      highestFeuerwerkTurnScore = p.highestFeuerwerkTurnScore ?? 0;
    }
    if ((p.highestX2TurnScore ?? 0) > highestX2TurnScore) {
      highestX2TurnScore = p.highestX2TurnScore ?? 0;
    }
    if (isWinner(p)) {
      if (fastestWinTurns === null || p.totalTurns < fastestWinTurns) {
        fastestWinTurns = p.totalTurns;
      }
    } else {
      if (fastestLossTurns === null || p.totalTurns < fastestLossTurns) {
        fastestLossTurns = p.totalTurns;
      }
    }
  });

  return {
    gamesPlayed: 1, totalPlaytime: finalTime,
    totalPlusMinus, totalKniffel, totalStop, totalFeuerwerk,
    totalKleeblatt, totalKleeblattCompleted, totalx2,
    totalTurns, totalScore, totalPlusMinusCompleted, totalKniffelCompleted,
    totalFeuerwerkPoints, totalx2Points, totalFeuerwerkBusts, totalx2Busts, totalBusts,
    highestTurnScore, fastestWinTurns, fastestLossTurns, isDefaultGame,
    totalPlayersSum: finalPlayers.length, mostPlayersInGame: finalPlayers.length,
    totalRoundsSum: finalRound, longestGameRounds: finalRound,
    highestFeuerwerkTurnScore, highestX2TurnScore,
    totalTuttos, mostCardsInTurn, highestForfeitedTurnScore,
  };
};

export const calculateNextTurn = (
  gameState: CoreGameState & { currentPlayerIndex: number },
  scoreInput: number,
  isSuccess = false,
  turnSummary?: TurnSummary,
): NextTurnResult => {
  const { players, currentPlayerIndex, currentCard, round, winningScore, cards, initialCards } = gameState;

  let turnScore = Number.isFinite(scoreInput) ? scoreInput : 0;
  const newPlayers = players.map(p => ({ ...p }));
  const currentPlayer = newPlayers[currentPlayerIndex];
  let snapshotLeaders: Player[] | null = null;
  let summaryForState: TurnSummary | null = null;

  currentPlayer.totalTurns = (currentPlayer.totalTurns ?? 0) + 1;

  let wasBust: boolean;
  let historyType: HistoryEventType;
  let historyCard: CardType;

  if (turnSummary) {
    // ── Classic path: the summary owns every per-card counter and the score
    // arrives fully computed by the playing client (straight +2000,
    // Plus/Minus +1000 per success, bonus added, x2 doubling applied).
    summaryForState = { ...turnSummary, cards: turnSummary.cards.map(c => ({ ...c })) };

    wasBust = turnSummary.ended === 'null';
    if (wasBust) currentPlayer.busts = (currentPlayer.busts ?? 0) + 1;
    // Deliberately NO feuerwerkBusts/x2Busts and no per-card point/turn-score
    // attribution here: "which card the chain died on" has no counterpart in
    // the modernized stats, and the classic buckets do not display them.

    // The classic records. Their pre-turn values ride the stored summary so
    // undo can restore them (see calculateUndo).
    summaryForState.prevMostCardsInTurn = currentPlayer.mostCardsInTurn ?? null;
    summaryForState.prevHighestForfeitedTurnScore = currentPlayer.highestForfeitedTurnScore ?? null;
    currentPlayer.totalTuttos = (currentPlayer.totalTuttos ?? 0) + turnSummary.tuttoCount;
    if (turnSummary.cards.length > (currentPlayer.mostCardsInTurn ?? 0)) {
      currentPlayer.mostCardsInTurn = turnSummary.cards.length;
    }
    if (!isSuccess && (turnSummary.forfeitedScore ?? 0) > (currentPlayer.highestForfeitedTurnScore ?? 0)) {
      currentPlayer.highestForfeitedTurnScore = turnSummary.forfeitedScore;
    }

    for (const played of turnSummary.cards) {
      switch (played.card) {
        case 'Feuerwerk': currentPlayer.timesFeuerwerkReceived = (currentPlayer.timesFeuerwerkReceived ?? 0) + 1; break;
        case 'x2': currentPlayer.timesx2Received = (currentPlayer.timesx2Received ?? 0) + 1; break;
        case 'Stop': currentPlayer.timesSkipped = (currentPlayer.timesSkipped ?? 0) + 1; break;
        case 'Kniffel':
          if (played.completed) currentPlayer.timesKniffelCompleted = (currentPlayer.timesKniffelCompleted ?? 0) + 1;
          else currentPlayer.timesKniffelFailed = (currentPlayer.timesKniffelFailed ?? 0) + 1;
          break;
        case 'Plus_Minus':
          if (played.completed) currentPlayer.timesPlusMinusCompleted = (currentPlayer.timesPlusMinusCompleted ?? 0) + 1;
          else currentPlayer.timesPlusMinusFailed = (currentPlayer.timesPlusMinusFailed ?? 0) + 1;
          break;
        case 'Kleeblatt':
          // A completed Kleeblatt is the instant win, owned by the branch
          // further down — counting it here too would double it.
          if (!played.completed) currentPlayer.timesKleeblattFailed = (currentPlayer.timesKleeblattFailed ?? 0) + 1;
          break;
        default: break; // bonus cards have no counters
      }
    }

    // Atomic Plus/Minus: the ±1000s resolve only when the turn actually
    // banks — a later null/Stop forfeits them along with everything else.
    // Applied sequentially (leaders recomputed between deductions) with the
    // same self-exclusion rule as the modernized path below.
    if (isSuccess && turnSummary.plusMinusSuccesses > 0) {
      const preScores = new Map<string, Player>();
      const deducted: string[] = [];
      for (let i = 0; i < turnSummary.plusMinusSuccesses; i++) {
        const leaders = getLeaders(newPlayers);
        if (leaders.some(l => l.name === currentPlayer.name)) continue;
        leaders.forEach(l => {
          const p = newPlayers.find(np => np.name === l.name);
          if (!p) return;
          // First touch snapshots the true pre-commit score, so undo can
          // restore absolutely however many deductions follow.
          if (!preScores.has(p.name)) preScores.set(p.name, { ...p });
          p.times1000PointsDeducted = (p.times1000PointsDeducted ?? 0) + 1;
          // Official rule: "a player can never have less than 0 points" —
          // clamped here (classic) only; the modernized path keeps its
          // long-standing negative-scores behavior.
          p.score = Math.max(0, p.score - PLUS_MINUS_SCORE);
          deducted.push(p.name);
        });
      }
      if (deducted.length > 0) {
        snapshotLeaders = [...preScores.values()];
        summaryForState.deductedPlayers = deducted;
      }
    }

    historyType = isSuccess ? 'success' : 'bust';
    historyCard = turnSummary.cards[0]?.card ?? currentCard ?? 'Stop';
  } else {
    // ── Modernized path (also the server-timeout forfeit) — unchanged.
    wasBust = !isSuccess && !isSpecialCard(currentCard) && currentCard !== 'Stop';
    if (wasBust) {
      currentPlayer.busts = (currentPlayer.busts ?? 0) + 1;
      if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkBusts = (currentPlayer.feuerwerkBusts ?? 0) + 1;
      if (currentCard === 'x2') currentPlayer.x2Busts = (currentPlayer.x2Busts ?? 0) + 1;
    }

    if (currentCard === 'Plus_Minus' && isSuccess) {
      turnScore = PLUS_MINUS_SCORE;
      const leaders = getLeaders(newPlayers);
      const isLeader = leaders.find(l => l.name === currentPlayer.name);
      if (!isLeader) {
        snapshotLeaders = leaders.map(l => ({ ...l }));
        leaders.forEach(l => {
          const p = newPlayers.find(np => np.name === l.name);
          if (p) { p.times1000PointsDeducted = (p.times1000PointsDeducted ?? 0) + 1; p.score -= PLUS_MINUS_SCORE; }
        });
      }
      currentPlayer.timesPlusMinusCompleted = (currentPlayer.timesPlusMinusCompleted ?? 0) + 1;
    } else if (currentCard === 'Plus_Minus') {
      currentPlayer.timesPlusMinusFailed = (currentPlayer.timesPlusMinusFailed ?? 0) + 1;
    }

    if (currentCard === 'x2') currentPlayer.timesx2Received = (currentPlayer.timesx2Received ?? 0) + 1;
    if (currentCard === 'Feuerwerk') currentPlayer.timesFeuerwerkReceived = (currentPlayer.timesFeuerwerkReceived ?? 0) + 1;
    if (currentCard === 'Stop') currentPlayer.timesSkipped = (currentPlayer.timesSkipped ?? 0) + 1;

    if (currentCard === 'Kniffel' && isSuccess) {
      turnScore = KNIFFEL_SCORE;
      currentPlayer.timesKniffelCompleted = (currentPlayer.timesKniffelCompleted ?? 0) + 1;
    } else if (currentCard === 'Kniffel') {
      currentPlayer.timesKniffelFailed = (currentPlayer.timesKniffelFailed ?? 0) + 1;
    }

    if (currentCard === 'x2') currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored ?? 0) + turnScore;
    if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored ?? 0) + turnScore;

    historyType = 'success';
    if (currentCard === 'Stop') {
      historyType = 'skip';
    } else if (wasBust) {
      historyType = 'bust';
    } else if (isSpecialCard(currentCard)) {
      historyType = isSuccess ? 'success' : 'fail';
    }
    historyCard = currentCard ?? 'Stop';
  }

  const historyEntry: HistoryEntry = {
    // round-player-totalTurns is already a unique triple (totalTurns strictly
    // increments per player each turn) — no random suffix needed.
    id: `${round}-${currentPlayer.name}-${currentPlayer.totalTurns}`,
    round,
    playerName: currentPlayer.name,
    playerColor: currentPlayer.color,
    card: historyCard,
    type: historyType,
    score: currentCard === 'Kleeblatt' && isSuccess ? 0 : turnScore,
  };

  if (summaryForState && summaryForState.cards.length > 1) {
    historyEntry.cards = summaryForState.cards.map(c => c.card);
  }
  if (summaryForState?.deductedPlayers?.length) {
    historyEntry.deductedPlayers = [...summaryForState.deductedPlayers];
  } else if (!turnSummary && currentCard === 'Plus_Minus' && isSuccess && snapshotLeaders) {
    historyEntry.deductedPlayers = snapshotLeaders.map(l => l.name);
  }

  if (currentCard === 'Kleeblatt' && isSuccess) {
    currentPlayer.timesKleeblattCompleted = (currentPlayer.timesKleeblattCompleted ?? 0) + 1;
    // Kleeblatt is a binary instant-win, not a scored turn — the dice rolled to
    // complete it (turnScore/scoreInput) are never added to the score, matching
    // the physical-dice rules (no separate scoring for it). The score just needs
    // to (a) clear winningScore and (b) strictly exceed every other player's, so
    // this player is the sole leader — a synthetic "999999" sentinel score used
    // to do this by discarding the real score entirely, which corrupted average-
    // score stats (totalScore, dashboards) whenever a Kleeblatt game was included.
    const otherScores = newPlayers.filter(p => p.name !== currentPlayer.name).map(p => p.score);
    const highestOtherScore = otherScores.length > 0 ? Math.max(...otherScores) : -Infinity;
    currentPlayer.score = Math.max(winningScore, currentPlayer.score, highestOtherScore + 1);
    return {
      players: newPlayers, isGameOver: true, isRoundEnd: true,
      nextIndex: null, nextRound: round,
      previousCard: currentCard, previousScore: turnScore,
      previousLeaders: snapshotLeaders, previousWasBust: wasBust,
      previousWasSuccess: isSuccess,
      previousHighestTurnScore: currentPlayer.highestTurnScore ?? 0,
      previousHighestFeuerwerkTurnScore: currentPlayer.highestFeuerwerkTurnScore ?? 0,
      previousHighestX2TurnScore: currentPlayer.highestX2TurnScore ?? 0,
      previousPlayerName: currentPlayer.name,
      previousTurnSummary: summaryForState,
      newDeck: cards, drawnCard: null,
      historyEntry,
    };
  } else if (currentCard === 'Kleeblatt' && !turnSummary) {
    // Summary path already counted the failure from summary.cards.
    currentPlayer.timesKleeblattFailed = (currentPlayer.timesKleeblattFailed ?? 0) + 1;
  }

  const previousHighestTurnScore = currentPlayer.highestTurnScore ?? 0;
  const previousHighestFeuerwerkTurnScore = currentPlayer.highestFeuerwerkTurnScore ?? 0;
  const previousHighestX2TurnScore = currentPlayer.highestX2TurnScore ?? 0;
  if (turnScore > (currentPlayer.highestTurnScore ?? 0)) {
    currentPlayer.highestTurnScore = turnScore;
  }
  // Per-card turn records are a modernized concept — in a classic chain the
  // turn spans several cards, so "a Feuerwerk turn's score" is ill-defined.
  if (!turnSummary && currentCard === 'Feuerwerk' && turnScore > previousHighestFeuerwerkTurnScore) {
    currentPlayer.highestFeuerwerkTurnScore = turnScore;
  }
  if (!turnSummary && currentCard === 'x2' && turnScore > previousHighestX2TurnScore) {
    currentPlayer.highestX2TurnScore = turnScore;
  }
  currentPlayer.score += turnScore;

  let isGameOver = false;
  let nextIndex: number | null = currentPlayerIndex + 1;
  let nextRound = round;
  let isRoundEnd = false;

  if (nextIndex >= newPlayers.length) {
    isRoundEnd = true;
    const currentLeaders = getLeaders(newPlayers);
    if (currentLeaders[0].score >= winningScore && currentLeaders.length === 1) {
      isGameOver = true;
    }
    if (!isGameOver) { nextIndex = 0; nextRound++; }
  }

  let newDeck = [...cards];
  let drawnCard: CardType | null = null;

  if (!isGameOver) {
    if (newDeck.length === 0) newDeck = buildDeck(initialCards);
    drawnCard = newDeck.shift() ?? null;
  } else {
    nextIndex = null;
  }

  return {
    players: newPlayers, isGameOver, isRoundEnd,
    nextIndex,
    nextRound, previousCard: currentCard, previousScore: turnScore,
    previousLeaders: snapshotLeaders, previousWasBust: wasBust,
    previousWasSuccess: isSuccess,
    previousHighestTurnScore, previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
    previousPlayerName: currentPlayer.name,
    previousTurnSummary: summaryForState,
    newDeck, drawnCard,
    historyEntry,
  };
};

export const calculateUndo = (gameState: CoreGameState): UndoResult | null => {
  const {
    players, currentPlayerIndex, round, previousCard, previousScore,
    previousLeaders, previousWasBust, previousWasSuccess, previousHighestTurnScore,
    previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore, previousPlayerName,
    previousTurnSummary, currentCard, cards,
  } = gameState;

  // Whether the previous turn's card was completed. Read from the outcome
  // calculateNextTurn recorded; the score comparison is the compatibility path
  // for entries written before that field existed (see previousWasSuccess in
  // types.ts) — it is wrong for a failure worth exactly `fixedScore`, which is
  // why the flag exists, but it is what those entries were committed under.
  const wasCompleted = (fixedScore: number): boolean =>
    previousWasSuccess ?? (previousScore === fixedScore);

  if (gameState.finished) return null;
  // A bare Stop turn commits nothing (type 'skip') and stays un-undoable. A
  // classic chain that ENDED on a drawn Stop, however, forfeited real points
  // and mutated counters — its summary makes it undoable like any bust.
  if (!previousCard || (previousCard === 'Stop' && !previousTurnSummary)) return null;
  if (currentPlayerIndex === null) return null;
  if (!previousPlayerName) return null;

  const newPlayers = players.map(p => ({ ...p }));
  // Looked up by name (not "currentPlayerIndex - 1") so a roster change since
  // that turn — a leave, kick, or reconnect-timeout removal — can't make this
  // land on the wrong player. If the player who took that turn is no longer in
  // the game at all, there is no one to safely revert the turn onto.
  const prevIndex = newPlayers.findIndex(p => p.name === previousPlayerName);
  if (prevIndex === -1) return null;

  let newRound = round;
  let isRoundEndUndo = false;
  // Under normal play the previous player sits right before the current one
  // (prevIndex === currentPlayerIndex - 1). If instead they're at or after the
  // current index, turn order must have wrapped since their turn, so the round
  // that wrap advanced needs to be undone too.
  if (prevIndex >= currentPlayerIndex) {
    if (round <= 1) return null;
    newRound--;
    isRoundEndUndo = true;
  }

  const p = newPlayers[prevIndex];

  p.totalTurns = Math.max(0, (p.totalTurns ?? 0) - 1);

  if (previousTurnSummary) {
    // ── Classic chain reversal: mirror the summary path of calculateNextTurn
    // exactly — per-card counters from the card list, busts only for a dice
    // null, deduction counters per occurrence, absolute score restore from
    // the pre-commit leader snapshot.
    if (previousTurnSummary.ended === 'null') p.busts = Math.max(0, (p.busts ?? 0) - 1);

    for (const played of previousTurnSummary.cards) {
      switch (played.card) {
        case 'Feuerwerk': p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived ?? 0) - 1); break;
        case 'x2': p.timesx2Received = Math.max(0, (p.timesx2Received ?? 0) - 1); break;
        case 'Stop': p.timesSkipped = Math.max(0, (p.timesSkipped ?? 0) - 1); break;
        case 'Kniffel':
          if (played.completed) p.timesKniffelCompleted = Math.max(0, (p.timesKniffelCompleted ?? 0) - 1);
          else p.timesKniffelFailed = Math.max(0, (p.timesKniffelFailed ?? 0) - 1);
          break;
        case 'Plus_Minus':
          if (played.completed) p.timesPlusMinusCompleted = Math.max(0, (p.timesPlusMinusCompleted ?? 0) - 1);
          else p.timesPlusMinusFailed = Math.max(0, (p.timesPlusMinusFailed ?? 0) - 1);
          break;
        case 'Kleeblatt':
          // A completed Kleeblatt wins instantly and is un-undoable (the
          // finished guard above) — a reachable one is always a failure.
          if (!played.completed) p.timesKleeblattFailed = Math.max(0, (p.timesKleeblattFailed ?? 0) - 1);
          break;
        default: break;
      }
    }

    if (previousLeaders) {
      previousLeaders.forEach(pl => {
        const actual = newPlayers.find(np => np.name === pl.name);
        if (actual) actual.score = pl.score;
      });
    }
    for (const name of previousTurnSummary.deductedPlayers ?? []) {
      const actual = newPlayers.find(np => np.name === name);
      if (actual) actual.times1000PointsDeducted = Math.max(0, (actual.times1000PointsDeducted ?? 0) - 1);
    }

    p.totalTuttos = Math.max(0, (p.totalTuttos ?? 0) - previousTurnSummary.tuttoCount);
    if (previousTurnSummary.prevMostCardsInTurn !== undefined) {
      p.mostCardsInTurn = previousTurnSummary.prevMostCardsInTurn ?? undefined;
    }
    if (previousTurnSummary.prevHighestForfeitedTurnScore !== undefined) {
      p.highestForfeitedTurnScore = previousTurnSummary.prevHighestForfeitedTurnScore ?? undefined;
    }
  } else {
    // ── Modernized reversal — unchanged.
    if (previousCard === 'Feuerwerk') p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived ?? 0) - 1);

    if (previousWasBust && !isSpecialCard(previousCard)) {
      p.busts = Math.max(0, (p.busts ?? 0) - 1);
      if (previousCard === 'Feuerwerk') p.feuerwerkBusts = Math.max(0, (p.feuerwerkBusts ?? 0) - 1);
      if (previousCard === 'x2') p.x2Busts = Math.max(0, (p.x2Busts ?? 0) - 1);
    }

    if (previousCard === 'Feuerwerk') p.feuerwerkPointsScored = Math.max(0, (p.feuerwerkPointsScored ?? 0) - (previousScore ?? 0));
    if (previousCard === 'x2') p.x2PointsScored = Math.max(0, (p.x2PointsScored ?? 0) - (previousScore ?? 0));

    if (previousCard === 'Plus_Minus' && previousLeaders) {
      previousLeaders.forEach(pl => {
        const actual = newPlayers.find(np => np.name === pl.name);
        if (actual) {
          actual.score = pl.score;
          actual.times1000PointsDeducted = Math.max(0, (actual.times1000PointsDeducted ?? 0) - 1);
        }
      });
    }

    if (previousCard === 'Plus_Minus') {
      if (wasCompleted(PLUS_MINUS_SCORE)) p.timesPlusMinusCompleted = Math.max(0, (p.timesPlusMinusCompleted ?? 0) - 1);
      else p.timesPlusMinusFailed = Math.max(0, (p.timesPlusMinusFailed ?? 0) - 1);
    }

    if (previousCard === 'x2') p.timesx2Received = Math.max(0, (p.timesx2Received ?? 0) - 1);

    if (previousCard === 'Kniffel') {
      if (wasCompleted(KNIFFEL_SCORE)) p.timesKniffelCompleted = Math.max(0, (p.timesKniffelCompleted ?? 0) - 1);
      else p.timesKniffelFailed = Math.max(0, (p.timesKniffelFailed ?? 0) - 1);
    }

    // A Kleeblatt completion instantly wins the game, which makes it un-undoable
    // (the finished/currentPlayerIndex guards above return null first) — so a
    // reachable Kleeblatt undo always reverses a failure.
    if (previousCard === 'Kleeblatt') {
      p.timesKleeblattFailed = Math.max(0, (p.timesKleeblattFailed ?? 0) - 1);
    }
  }

  if (previousHighestTurnScore !== undefined) p.highestTurnScore = previousHighestTurnScore;
  if (previousHighestFeuerwerkTurnScore !== undefined) p.highestFeuerwerkTurnScore = previousHighestFeuerwerkTurnScore;
  if (previousHighestX2TurnScore !== undefined) p.highestX2TurnScore = previousHighestX2TurnScore;
  p.score -= (previousScore ?? 0);

  // A chained turn consumed several cards: put them all back so the replayed
  // turn draws the exact same sequence — the first chain card is re-dealt,
  // the rest go back on top of the deck ahead of the next player's card.
  const chainCards = previousTurnSummary?.cards.map(c => c.card);
  const hasChain = !!chainCards && chainCards.length > 0;

  return {
    players: newPlayers,
    nextIndex: prevIndex,
    nextRound: newRound,
    isRoundEndUndo,
    newDeck: hasChain
      ? [...chainCards.slice(1), ...(currentCard ? [currentCard] : []), ...cards]
      : (currentCard ? [currentCard, ...cards] : [...cards]),
    drawnCard: hasChain ? chainCards[0] : previousCard as CardType,
  };
};
