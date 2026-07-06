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
} from '../types';

// A deck with every card type at 0 leaves currentCard permanently null and the
// game unplayable — both lobbies must refuse to start in that state.
export const hasPlayableDeck = (initialCards: InitialCards | undefined): boolean =>
  Object.values(initialCards ?? {}).some(count => (count ?? 0) > 0);

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
): GlobalStatsPayload => {
  let totalPlusMinus = 0, totalKniffel = 0, totalStop = 0, totalFeuerwerk = 0,
    totalKleeblatt = 0, totalKleeblattCompleted = 0, totalx2 = 0;
  let totalTurns = 0, totalScore = 0;
  let totalPlusMinusCompleted = 0, totalKniffelCompleted = 0;
  let totalFeuerwerkPoints = 0, totalx2Points = 0;
  let totalFeuerwerkBusts = 0, totalx2Busts = 0, totalBusts = 0;
  let highestTurnScore = 0;
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
    if ((p.highestTurnScore ?? 0) > highestTurnScore) {
      highestTurnScore = p.highestTurnScore ?? 0;
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
  };
};

export const calculateNextTurn = (
  gameState: CoreGameState & { currentPlayerIndex: number },
  scoreInput: number,
  isSuccess = false,
): NextTurnResult => {
  const { players, currentPlayerIndex, currentCard, round, winningScore, cards, initialCards } = gameState;

  let turnScore = scoreInput || 0;
  const newPlayers = players.map(p => ({ ...p }));
  const currentPlayer = newPlayers[currentPlayerIndex];
  let snapshotLeaders: Player[] | null = null;

  currentPlayer.totalTurns = (currentPlayer.totalTurns ?? 0) + 1;
  const isYesNoCard = ((['Plus_Minus', 'Kniffel', 'Kleeblatt'] as string[]).includes(currentCard ?? ''));
  const wasBust = !isSuccess && !isYesNoCard && currentCard !== 'Stop';
  if (wasBust) {
    currentPlayer.busts = (currentPlayer.busts ?? 0) + 1;
    if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkBusts = (currentPlayer.feuerwerkBusts ?? 0) + 1;
    if (currentCard === 'x2') currentPlayer.x2Busts = (currentPlayer.x2Busts ?? 0) + 1;
  }

  if (currentCard === 'Plus_Minus' && isSuccess) {
    turnScore = 1000;
    const leaders = getLeaders(newPlayers);
    const isLeader = leaders.find(l => l.name === currentPlayer.name);
    if (!isLeader) {
      snapshotLeaders = leaders.map(l => ({ ...l }));
      leaders.forEach(l => {
        const p = newPlayers.find(np => np.name === l.name);
        if (p) { p.times1000PointsDeducted = (p.times1000PointsDeducted ?? 0) + 1; p.score -= 1000; }
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
    turnScore = 2000;
    currentPlayer.timesKniffelCompleted = (currentPlayer.timesKniffelCompleted ?? 0) + 1;
  } else if (currentCard === 'Kniffel') {
    currentPlayer.timesKniffelFailed = (currentPlayer.timesKniffelFailed ?? 0) + 1;
  }

  if (currentCard === 'x2') currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored ?? 0) + turnScore;
  if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored ?? 0) + turnScore;

  let historyType: HistoryEventType = 'success';
  if (currentCard === 'Stop') {
    historyType = 'skip';
  } else if (wasBust) {
    historyType = 'bust';
  } else if (currentCard && ['Plus_Minus', 'Kniffel', 'Kleeblatt'].includes(currentCard)) {
    historyType = isSuccess ? 'success' : 'fail';
  }

  const historyEntry: HistoryEntry = {
    id: `${round}-${currentPlayer.name}-${currentPlayer.totalTurns}-${Math.random().toString(36).substring(2, 8)}`,
    round,
    playerName: currentPlayer.name,
    playerColor: currentPlayer.color,
    card: currentCard ?? 'Stop',
    type: historyType,
    score: currentCard === 'Kleeblatt' && isSuccess ? 0 : turnScore,
  };

  if (currentCard === 'Plus_Minus' && isSuccess && snapshotLeaders) {
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
      previousHighestTurnScore: currentPlayer.highestTurnScore ?? 0,
      previousPlayerName: currentPlayer.name,
      newDeck: cards, drawnCard: null,
      historyEntry,
    };
  } else if (currentCard === 'Kleeblatt') {
    currentPlayer.timesKleeblattFailed = (currentPlayer.timesKleeblattFailed ?? 0) + 1;
  }

  const previousHighestTurnScore = currentPlayer.highestTurnScore ?? 0;
  if (turnScore > (currentPlayer.highestTurnScore ?? 0)) {
    currentPlayer.highestTurnScore = turnScore;
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
    previousHighestTurnScore, previousPlayerName: currentPlayer.name,
    newDeck, drawnCard,
    historyEntry,
  };
};

export const calculateUndo = (gameState: CoreGameState): UndoResult | null => {
  const {
    players, currentPlayerIndex, round, previousCard, previousScore,
    previousLeaders, previousWasBust, previousHighestTurnScore, previousPlayerName,
    currentCard, cards,
  } = gameState;

  if (gameState.finished) return null;
  if (!previousCard || previousCard === 'Stop') return null;
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

  if (previousCard === 'Feuerwerk') p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived ?? 0) - 1);
  p.totalTurns = Math.max(0, (p.totalTurns ?? 0) - 1);

  const wasYesNoCard = ((['Plus_Minus', 'Kniffel', 'Kleeblatt'] as string[]).includes(previousCard));
  if (previousWasBust && !wasYesNoCard) {
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
    if (previousScore === 1000) p.timesPlusMinusCompleted = Math.max(0, (p.timesPlusMinusCompleted ?? 0) - 1);
    else p.timesPlusMinusFailed = Math.max(0, (p.timesPlusMinusFailed ?? 0) - 1);
  }

  if (previousCard === 'x2') p.timesx2Received = Math.max(0, (p.timesx2Received ?? 0) - 1);

  if (previousCard === 'Kniffel') {
    if (previousScore === 2000) p.timesKniffelCompleted = Math.max(0, (p.timesKniffelCompleted ?? 0) - 1);
    else p.timesKniffelFailed = Math.max(0, (p.timesKniffelFailed ?? 0) - 1);
  }

  // A Kleeblatt completion instantly wins the game, which makes it un-undoable
  // (the finished/currentPlayerIndex guards above return null first) — so a
  // reachable Kleeblatt undo always reverses a failure.
  if (previousCard === 'Kleeblatt') {
    p.timesKleeblattFailed = Math.max(0, (p.timesKleeblattFailed ?? 0) - 1);
  }

  if (previousHighestTurnScore !== undefined) p.highestTurnScore = previousHighestTurnScore;
  p.score -= (previousScore ?? 0);

  return {
    players: newPlayers,
    nextIndex: prevIndex,
    nextRound: newRound,
    isRoundEndUndo,
    newDeck: [currentCard as CardType, ...cards],
    drawnCard: previousCard as CardType,
  };
};
