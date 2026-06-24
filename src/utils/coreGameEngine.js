export const shuffleArray = (array) => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

export const buildDeck = (initialCards) => {
  const newCards = [];
  Object.keys(initialCards).forEach(cardType => {
    for (let i = 0; i < initialCards[cardType]; i++) {
      newCards.push(cardType);
    }
  });
  return shuffleArray(newCards);
};

export const getLeaders = (players) => {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return [];
  const topScore = sorted[0].score;
  return sorted.filter(p => p.score === topScore);
};

export const buildGlobalStatsPayload = (finalPlayers, finalTime, isDefaultGame) => {
  let totalPlusMinus = 0, totalKniffel = 0, totalStop = 0, totalFeuerwerk = 0, totalKleeblatt = 0, totalKleeblattCompleted = 0, totalx2 = 0;
  let totalTurns = 0, totalScore = 0;
  let totalPlusMinusCompleted = 0, totalKniffelCompleted = 0;
  let totalFeuerwerkPoints = 0, totalx2Points = 0;
  let totalFeuerwerkBusts = 0, totalx2Busts = 0, totalBusts = 0;
  let highestTurnScore = 0;
  let fastestWinTurns = null;
  let fastestLossTurns = null;

  const leaders = getLeaders(finalPlayers);
  const isWinner = (p) => leaders.some(l => l.name === p.name);
  
  finalPlayers.forEach(p => {
    totalPlusMinus += ((p.timesPlusMinusCompleted || 0) + (p.timesPlusMinusFailed || 0));
    totalKniffel += ((p.timesKniffelCompleted || 0) + (p.timesKniffelFailed || 0));
    totalStop += (p.timesSkipped || 0);
    totalFeuerwerk += (p.timesFeuerwerkReceived || 0);
    totalKleeblatt += ((p.timesKleeblattFailed || 0) + (p.timesKleeblattCompleted || 0));
    totalKleeblattCompleted += (p.timesKleeblattCompleted || 0);
    totalx2 += (p.timesx2Received || 0);
    totalTurns += (p.totalTurns || 0);
    totalScore += (p.score || 0);
    totalPlusMinusCompleted += (p.timesPlusMinusCompleted || 0);
    totalKniffelCompleted += (p.timesKniffelCompleted || 0);
    totalFeuerwerkPoints += (p.feuerwerkPointsScored || 0);
    totalx2Points += (p.x2PointsScored || 0);
    totalFeuerwerkBusts += (p.feuerwerkBusts || 0);
    totalx2Busts += (p.x2Busts || 0);
    totalBusts += (p.busts || 0);
    if ((p.highestTurnScore || 0) > highestTurnScore) {
      highestTurnScore = p.highestTurnScore;
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
    gamesPlayed: 1,
    totalPlaytime: finalTime,
    totalPlusMinus, totalKniffel, totalStop, totalFeuerwerk, totalKleeblatt, totalKleeblattCompleted, totalx2,
    totalTurns, totalScore, totalPlusMinusCompleted, totalKniffelCompleted, totalFeuerwerkPoints, totalx2Points,
    totalFeuerwerkBusts, totalx2Busts, totalBusts,
    highestTurnScore, fastestWinTurns, fastestLossTurns,
    isDefaultGame
  };
};

export const calculateNextTurn = (gameState, scoreInput, isSuccess = false) => {
  const { players, currentPlayerIndex, currentCard, round, winningScore, cards, initialCards } = gameState;
  
  let turnScore = scoreInput || 0;
  let newPlayers = players.map(p => ({ ...p }));
  let currentPlayer = newPlayers[currentPlayerIndex];
  let snapshotLeaders = null;

  // Track turns and busts.
  currentPlayer.totalTurns = (currentPlayer.totalTurns || 0) + 1;
  const isYesNoCard = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(currentCard);
  const wasBust = !isSuccess && !isYesNoCard && currentCard !== "Stop";
  if (wasBust) {
    currentPlayer.busts = (currentPlayer.busts || 0) + 1;
    if (currentCard === "Feuerwerk") currentPlayer.feuerwerkBusts = (currentPlayer.feuerwerkBusts || 0) + 1;
    if (currentCard === "x2") currentPlayer.x2Busts = (currentPlayer.x2Busts || 0) + 1;
  }

  if (currentCard === "Plus_Minus" && isSuccess) {
    turnScore = 1000;
    const leaders = getLeaders(newPlayers);
    const isLeader = leaders.find(l => l.name === currentPlayer.name);
    
    if (!isLeader) {
      snapshotLeaders = leaders.map(l => ({...l})); // backup
      leaders.forEach(l => {
        const p = newPlayers.find(np => np.name === l.name);
        p.times1000PointsDeducted = (p.times1000PointsDeducted || 0) + 1;
        p.score = Math.max(0, p.score - 1000);
      });
    }
    currentPlayer.timesPlusMinusCompleted = (currentPlayer.timesPlusMinusCompleted || 0) + 1;
  } else if (currentCard === "Plus_Minus") {
    currentPlayer.timesPlusMinusFailed = (currentPlayer.timesPlusMinusFailed || 0) + 1;
  }

  if (currentCard === "x2") {
    currentPlayer.timesx2Received = (currentPlayer.timesx2Received || 0) + 1;
  }
  if (currentCard === "Feuerwerk") {
    currentPlayer.timesFeuerwerkReceived = (currentPlayer.timesFeuerwerkReceived || 0) + 1;
  }
  if (currentCard === "Stop") {
    currentPlayer.timesSkipped = (currentPlayer.timesSkipped || 0) + 1;
  }

  if (currentCard === "Kniffel" && isSuccess) {
    turnScore = 2000;
    currentPlayer.timesKniffelCompleted = (currentPlayer.timesKniffelCompleted || 0) + 1;
  } else if (currentCard === "Kniffel") {
    currentPlayer.timesKniffelFailed = (currentPlayer.timesKniffelFailed || 0) + 1;
  }

  if (currentCard === "x2") {
    currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored || 0) + turnScore;
  }
  if (currentCard === "Feuerwerk") {
    currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored || 0) + turnScore;
  }

  if (currentCard === "Kleeblatt" && isSuccess) {
    currentPlayer.timesKleeblattCompleted = (currentPlayer.timesKleeblattCompleted || 0) + 1;
    currentPlayer.score = 999999;
    return {
      players: newPlayers,
      isGameOver: true,
      nextIndex: null,
      nextRound: round,
      previousCard: currentCard,
      previousScore: turnScore,
      previousLeaders: snapshotLeaders,
      previousWasBust: wasBust,
      previousHighestTurnScore: currentPlayer.highestTurnScore ?? 0,
      newDeck: cards,
      drawnCard: null
    };
  } else if (currentCard === "Kleeblatt") {
    currentPlayer.timesKleeblattFailed = (currentPlayer.timesKleeblattFailed || 0) + 1;
  }

  const previousHighestTurnScore = currentPlayer.highestTurnScore ?? 0;
  if (turnScore > (currentPlayer.highestTurnScore || 0)) {
    currentPlayer.highestTurnScore = turnScore;
  }
  currentPlayer.score += turnScore;
  
  // Check winner
  let isGameOver = false;
  let nextIndex = currentPlayerIndex + 1;
  let nextRound = round;
  let isRoundEnd = false;

  if (nextIndex >= newPlayers.length) {
    isRoundEnd = true;
    const currentLeaders = getLeaders(newPlayers);
    if (currentLeaders[0].score >= winningScore) {
      if (currentLeaders.length === 1) {
        isGameOver = true;
      }
    }
    if (!isGameOver) {
      nextIndex = 0;
      nextRound++;
    }
  }

  let newDeck = [...cards];
  let drawnCard = null;
  
  if (!isGameOver) {
    if (newDeck.length === 0) {
      newDeck = buildDeck(initialCards);
    }
    drawnCard = newDeck.shift();
  } else {
    nextIndex = null;
  }

  return {
    players: newPlayers,
    isGameOver,
    isRoundEnd,
    nextIndex,
    nextRound,
    previousCard: currentCard,
    previousScore: turnScore,
    previousLeaders: snapshotLeaders,
    previousWasBust: wasBust,
    previousHighestTurnScore,
    newDeck,
    drawnCard
  };
};

export const calculateUndo = (gameState) => {
  const { players, currentPlayerIndex, round, previousCard, previousScore, previousLeaders, previousWasBust, previousHighestTurnScore, currentCard, cards } = gameState;
  
  if (!previousCard || previousCard === "Stop") return null;

  let newPlayers = players.map(p => ({ ...p }));
  let prevIndex = currentPlayerIndex - 1;
  let newRound = round;
  let isRoundEndUndo = false;
  
  if (prevIndex < 0) {
    if (round <= 1) return null;
    prevIndex = newPlayers.length - 1;
    newRound--;
    isRoundEndUndo = true;
  }

  let p = newPlayers[prevIndex];

  if (previousCard === "Feuerwerk") p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived || 0) - 1);

  p.totalTurns = Math.max(0, (p.totalTurns || 0) - 1);
  const wasYesNoCard = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(previousCard);
  if (previousWasBust && previousCard !== "Stop" && !wasYesNoCard) {
    p.busts = Math.max(0, (p.busts || 0) - 1);
    if (previousCard === "Feuerwerk") p.feuerwerkBusts = Math.max(0, (p.feuerwerkBusts || 0) - 1);
    if (previousCard === "x2") p.x2Busts = Math.max(0, (p.x2Busts || 0) - 1);
  }

  if (previousCard === "Feuerwerk") {
    p.feuerwerkPointsScored = Math.max(0, (p.feuerwerkPointsScored || 0) - previousScore);
  }
  if (previousCard === "x2") {
    p.x2PointsScored = Math.max(0, (p.x2PointsScored || 0) - previousScore);
  }
  
  if (previousCard === "Plus_Minus" && previousLeaders) {
    previousLeaders.forEach(pl => {
      let actual = newPlayers.find(np => np.name === pl.name);
      if (actual) {
        actual.score = pl.score;
        actual.times1000PointsDeducted = Math.max(0, (actual.times1000PointsDeducted || 0) - 1);
      }
    });
  }

  if (previousCard === "Plus_Minus") {
    if (previousScore === 1000) p.timesPlusMinusCompleted = Math.max(0, (p.timesPlusMinusCompleted || 0) - 1);
    else p.timesPlusMinusFailed = Math.max(0, (p.timesPlusMinusFailed || 0) - 1);
  }

  if (previousCard === "x2") p.timesx2Received = Math.max(0, (p.timesx2Received || 0) - 1);
  
  if (previousCard === "Kniffel") {
    if (previousScore === 2000) p.timesKniffelCompleted = Math.max(0, (p.timesKniffelCompleted || 0) - 1);
    else p.timesKniffelFailed = Math.max(0, (p.timesKniffelFailed || 0) - 1);
  }

  if (previousCard === "Kleeblatt") {
    if (previousScore > 0) {
      p.timesKleeblattCompleted = Math.max(0, (p.timesKleeblattCompleted || 0) - 1);
    } else {
      p.timesKleeblattFailed = Math.max(0, (p.timesKleeblattFailed || 0) - 1);
    }
  }

  if (previousHighestTurnScore !== undefined) {
    p.highestTurnScore = previousHighestTurnScore;
  }

  p.score -= previousScore;

  return {
    players: newPlayers,
    nextIndex: prevIndex,
    nextRound: newRound,
    isRoundEndUndo,
    newDeck: [currentCard, ...cards],
    drawnCard: previousCard
  };
};
