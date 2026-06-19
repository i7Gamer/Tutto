import { useState, useEffect, useCallback } from 'react';

const INITIAL_CARDS = {
  Kleeblatt: 1,
  Feuerwerk: 5,
  Stop: 10,
  Kniffel: 5,
  Plus_Minus: 5,
  x2: 5,
  200: 5,
  300: 5,
  400: 5,
  500: 5,
  600: 5,
};

const createInitialPlayer = (name) => ({
  name,
  score: 0,
  times1000PointsDeducted: 0,
  timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0,
  timesKniffelFailed: 0,
  timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0,
  timesPlusMinusFailed: 0,
  timesFeuerwerkReceived: 0,
  timesSkipped: 0,
  timesx2Received: 0,
  totalTurns: 0,
  busts: 0,
  feuerwerkPointsScored: 0,
  x2PointsScored: 0,
  position: 0,
});

export function useGameLogic() {
  const [players, setPlayers] = useState([]);
  const [initialCards, setInitialCards] = useState(INITIAL_CARDS);
  const [cards, setCards] = useState([]);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(null);
  const [currentCard, setCurrentCard] = useState(null);
  const [round, setRound] = useState(1);
  const [winningScore, setWinningScore] = useState(6000);
  const [finished, setFinished] = useState(false);
  const [randomOrder, setRandomOrder] = useState(true);
  
  // Timer
  const [gameTimeInSeconds, setGameTimeInSeconds] = useState(0);

  // Undo state
  const [previousScore, setPreviousScore] = useState(null);
  const [previousCard, setPreviousCard] = useState(null);
  const [previousLeaders, setPreviousLeaders] = useState(null);

  // Chart data
  const [chartValues, setChartValues] = useState([]);
  const [chartNames, setChartNames] = useState([]);
  const [chartLabels, setChartLabels] = useState([]);

  // Load from local storage on mount
  useEffect(() => {
    const savedPlayers = localStorage.getItem('players');
    if (savedPlayers) {
      setPlayers(JSON.parse(savedPlayers));
      const savedIndex = localStorage.getItem('currentPlayerIndex');
      if (savedIndex !== "null" && savedIndex !== null) {
        setCurrentPlayerIndex(JSON.parse(savedIndex));
        setRound(JSON.parse(localStorage.getItem('currentRound')) || 1);
        setCurrentCard(localStorage.getItem('currentCard'));
        setGameTimeInSeconds(JSON.parse(localStorage.getItem('gameTimeInSeconds')) || 0);
        setCards(JSON.parse(localStorage.getItem('cards')) || []);
        setChartValues(JSON.parse(localStorage.getItem('chartValues')) || []);
        setChartNames(JSON.parse(localStorage.getItem('chartNames')) || []);
        setChartLabels(JSON.parse(localStorage.getItem('chartLabels')) || []);
        setFinished(JSON.parse(localStorage.getItem('finished')) || false);
        const savedRandomOrder = localStorage.getItem('randomOrder');
        if (savedRandomOrder !== null) setRandomOrder(JSON.parse(savedRandomOrder));
      }
    }
  }, []);

  // Timer interval
  useEffect(() => {
    let interval = null;
    if (currentPlayerIndex !== null && !finished) {
      interval = setInterval(() => {
        setGameTimeInSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [currentPlayerIndex, finished]);

  // Save to local storage automatically
  useEffect(() => {
    localStorage.setItem('players', JSON.stringify(players));
    localStorage.setItem('currentPlayerIndex', JSON.stringify(currentPlayerIndex));
    localStorage.setItem('currentRound', JSON.stringify(round));
    if (currentCard) localStorage.setItem('currentCard', currentCard);
    localStorage.setItem('gameTimeInSeconds', JSON.stringify(gameTimeInSeconds));
    localStorage.setItem('cards', JSON.stringify(cards));
    localStorage.setItem('chartValues', JSON.stringify(chartValues));
    localStorage.setItem('chartNames', JSON.stringify(chartNames));
    localStorage.setItem('chartLabels', JSON.stringify(chartLabels));
    localStorage.setItem('finished', JSON.stringify(finished));
    localStorage.setItem('randomOrder', JSON.stringify(randomOrder));
  }, [players, currentPlayerIndex, round, currentCard, gameTimeInSeconds, cards, chartValues, chartNames, chartLabels, finished, randomOrder]);

  const addPlayer = (name) => {
    setPlayers((prev) => [...prev, createInitialPlayer(name)]);
  };

  const removePlayer = (name) => {
    setPlayers((prev) => prev.filter(p => p.name !== name));
  };

  const reorderPlayers = (newPlayers) => {
    setPlayers(newPlayers);
    setRandomOrder(false);
  };

  const shuffleArray = (array) => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  };

  const shuffleCards = useCallback((deckConfig = initialCards) => {
    const newCards = [];
    Object.keys(deckConfig).forEach(cardType => {
      for (let i = 0; i < deckConfig[cardType]; i++) {
        newCards.push(cardType);
      }
    });
    return shuffleArray(newCards);
  }, [initialCards]);

  const drawCard = (deck) => {
    if (deck.length === 0) {
      deck = shuffleCards();
    }
    const drawnCard = deck.shift();
    setCards(deck);
    setCurrentCard(drawnCard);
    return { drawnCard, deck };
  };

  const createChartValues = (playerList) => {
    setChartNames(playerList.map(p => p.name));
    setChartValues(playerList.map(() => []));
  };

  const recordChartData = (currentPlayers) => {
    setChartValues(prev => {
      const newVals = [...prev];
      currentPlayers.forEach((p, i) => {
        if(newVals[i]) newVals[i].push(p.score);
      });
      return newVals;
    });
    setChartLabels(prev => [...prev, round]);
  };

  const startGame = () => {
    const resetPlayers = players.map(p => createInitialPlayer(p.name));
    let nextPlayers = resetPlayers;
    if (randomOrder) {
      nextPlayers = shuffleArray(resetPlayers);
    }
    
    setPlayers(nextPlayers);
    setRound(1);
    setGameTimeInSeconds(0);
    setFinished(false);
    setChartValues([]);
    setChartNames([]);
    setChartLabels([]);
    setPreviousCard(null);
    setPreviousScore(null);
    setPreviousLeaders(null);

    createChartValues(nextPlayers);

    const initialDeck = shuffleCards();
    drawCard(initialDeck);
    setCurrentPlayerIndex(0);
  };

  const endGame = () => {
    setFinished(false);
    setCurrentPlayerIndex(null);
    setGameTimeInSeconds(0);
    setRound(1);
    setCurrentCard(null);
    // players remain
  };

  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);
  sortedPlayers.forEach((p, i) => {
    if (i > 0 && p.score === sortedPlayers[i - 1].score) {
      p.position = sortedPlayers[i - 1].position;
    } else {
      p.position = i === 0 ? 1 : sortedPlayers[i - 1].position + 1;
    }
  });

  const getLeaders = (currentPlayers) => {
    const sorted = [...currentPlayers].sort((a, b) => b.score - a.score);
    if (!sorted.length) return [];
    const topScore = sorted[0].score;
    return sorted.filter(p => p.score === topScore);
  };

  const sendGlobalStats = (finalPlayers, finalTime, finalCard) => {
    let totalPlusMinus = 0, totalKniffel = 0, totalStop = 0, totalFeuerwerk = 0, totalKleeblatt = 0, totalKleeblattCompleted = 0, totalx2 = 0;
    let totalTurns = 0, totalScore = 0;
    let totalPlusMinusCompleted = 0, totalKniffelCompleted = 0;
    let totalFeuerwerkPoints = 0, totalx2Points = 0;
    finalPlayers.forEach(p => {
      totalPlusMinus += (p.timesPlusMinusCompleted + p.timesPlusMinusFailed);
      totalKniffel += (p.timesKniffelCompleted + p.timesKniffelFailed);
      totalStop += p.timesSkipped;
      totalFeuerwerk += p.timesFeuerwerkReceived;
      totalKleeblatt += (p.timesKleeblattFailed + (p.timesKleeblattCompleted || 0));
      totalKleeblattCompleted += (p.timesKleeblattCompleted || 0);
      totalx2 += p.timesx2Received;
      totalTurns += (p.totalTurns || 0);
      totalScore += p.score;
      totalPlusMinusCompleted += p.timesPlusMinusCompleted;
      totalKniffelCompleted += p.timesKniffelCompleted;
      totalFeuerwerkPoints += (p.feuerwerkPointsScored || 0);
      totalx2Points += (p.x2PointsScored || 0);
    });

    const isDefaultGame = (() => {
      if (winningScore !== 6000) return false;
      for (const key in INITIAL_CARDS) {
        if (initialCards[key] !== INITIAL_CARDS[key]) return false;
      }
      for (const key in initialCards) {
        if (initialCards[key] !== INITIAL_CARDS[key]) return false;
      }
      return true;
    })();

    fetch('/api/stats/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gamesPlayed: 1,
        totalPlaytime: finalTime,
        totalPlusMinus, totalKniffel, totalStop, totalFeuerwerk, totalKleeblatt, totalKleeblattCompleted, totalx2,
        totalTurns, totalScore, totalPlusMinusCompleted, totalKniffelCompleted, totalFeuerwerkPoints, totalx2Points,
        isDefaultGame
      })
    }).catch(console.error);
  };

  const nextTurn = (scoreInput, isSuccess = false) => {
    let turnScore = scoreInput || 0;
    let newPlayers = [...players];
    let currentPlayer = newPlayers[currentPlayerIndex];
    let snapshotLeaders = null;

    // Track turns and busts (bust = 0 points on a non-Stop card)
    currentPlayer.totalTurns++;
    if (turnScore === 0 && currentCard !== "Stop" && !isSuccess) {
      currentPlayer.busts++;
    }

    if (currentCard === "Plus_Minus" && isSuccess) {
      turnScore = 1000;
      const leaders = getLeaders(newPlayers);
      const isLeader = leaders.find(l => l.name === currentPlayer.name);
      
      if (!isLeader) {
        snapshotLeaders = leaders.map(l => ({...l})); // backup
        leaders.forEach(l => {
          const p = newPlayers.find(np => np.name === l.name);
          p.times1000PointsDeducted++;
          p.score -= 1000;
        });
      }
      currentPlayer.timesPlusMinusCompleted++;
    } else if (currentCard === "Plus_Minus") {
      currentPlayer.timesPlusMinusFailed++;
    }

    if (currentCard === "x2") {
      currentPlayer.timesx2Received++;
      currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored || 0) + turnScore;
    }
    if (currentCard === "Feuerwerk") {
      currentPlayer.timesFeuerwerkReceived++;
      currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored || 0) + turnScore;
    }
    if (currentCard === "Stop") currentPlayer.timesSkipped++;

    if (currentCard === "Kniffel" && isSuccess) {
      turnScore = 2000;
      currentPlayer.timesKniffelCompleted++;
    } else if (currentCard === "Kniffel") {
      currentPlayer.timesKniffelFailed++;
    }

    if (currentCard === "Kleeblatt" && isSuccess) {
      currentPlayer.timesKleeblattCompleted = (currentPlayer.timesKleeblattCompleted || 0) + 1;
      currentPlayer.score = 999999;
      setPlayers(newPlayers);
      setFinished(true);
      sendGlobalStats(newPlayers, gameTimeInSeconds, "Kleeblatt");
      return;
    } else if (currentCard === "Kleeblatt") {
      currentPlayer.timesKleeblattFailed++;
    }

    currentPlayer.score += turnScore;
    
    setPreviousCard(currentCard);
    setPreviousScore(turnScore);
    setPreviousLeaders(snapshotLeaders);

    // Check winner
    let isGameOver = false;
    let nextIndex = currentPlayerIndex + 1;
    let nextRound = round;

    if (nextIndex >= newPlayers.length) {
      // Round ended
      const currentLeaders = getLeaders(newPlayers);
      if (currentLeaders[0].score >= winningScore) {
        // If there's a tie for the top score, game continues? Original logic:
        // if (this.winner.score != this.sortedPlayers[1].score)
        if (currentLeaders.length === 1) {
          isGameOver = true;
          recordChartData(newPlayers);
        }
      }
      if (!isGameOver) {
        nextIndex = 0;
        recordChartData(newPlayers);
        nextRound++;
      }
    }

    setPlayers(newPlayers);
    
    if (isGameOver) {
      setFinished(true);
      setCurrentPlayerIndex(null);
      sendGlobalStats(newPlayers, gameTimeInSeconds, currentCard);
    } else {
      setCurrentPlayerIndex(nextIndex);
      setRound(nextRound);
      // Ensure cards are updated correctly from the state, but we need the latest deck
      let currentDeck = [...cards];
      if (currentDeck.length === 0) {
        currentDeck = shuffleCards();
      }
      const drawnCard = currentDeck.shift();
      setCards(currentDeck);
      setCurrentCard(drawnCard);
    }
  };

  const undo = () => {
    if (previousCard === "Stop" || !previousCard) return;

    let newPlayers = [...players];
    let prevIndex = currentPlayerIndex - 1;
    let newRound = round;
    
    if (prevIndex < 0) {
      prevIndex = newPlayers.length - 1;
      newRound--;
      // Remove last chart values
      setChartValues(prev => prev.map(vals => vals.slice(0, -1)));
      setChartLabels(prev => prev.slice(0, -1));
    }

    let p = newPlayers[prevIndex];

    if (currentCard === "Feuerwerk") p.timesFeuerwerkReceived--;
    
    if (previousCard === "Plus_Minus" && previousLeaders) {
      previousLeaders.forEach(pl => {
        let actual = newPlayers.find(np => np.name === pl.name);
        actual.score += 1000;
        actual.times1000PointsDeducted--;
      });
    }

    if (previousCard === "Plus_Minus") {
      if (previousScore === 1000) p.timesPlusMinusCompleted--;
      else p.timesPlusMinusFailed--;
    }

    if (previousCard === "x2") p.timesx2Received--;
    
    if (previousCard === "Kniffel") {
      if (previousScore === 2000) p.timesKniffelCompleted--;
      else p.timesKniffelFailed--;
    }

    p.score -= previousScore;

    setPlayers(newPlayers);
    setCurrentPlayerIndex(prevIndex);
    setRound(newRound);
    
    setCards(prev => [currentCard, ...prev]);
    setCurrentCard(previousCard);
    
    setPreviousCard(null);
    setPreviousScore(null);
    setPreviousLeaders(null);
  };

  const currentCardHasInput = !["Stop", "Plus_Minus", "Kniffel", "Kleeblatt"].includes(currentCard);
  const currentCardHasYesNo = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(currentCard);

  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  };

  return {
    players,
    sortedPlayers,
    currentPlayerIndex,
    currentPlayer: currentPlayerIndex !== null ? players[currentPlayerIndex] : null,
    currentCard,
    cards,
    round,
    winningScore,
    setWinningScore,
    initialCards,
    setInitialCards,
    randomOrder,
    setRandomOrder,
    gameTimeInSeconds,
    formattedTime: formatTime(gameTimeInSeconds),
    finished,
    addPlayer,
    removePlayer,
    reorderPlayers,
    startGame,
    endGame,
    nextTurn,
    undo,
    previousCard,
    chartValues,
    chartNames,
    chartLabels,
    currentCardHasInput,
    currentCardHasYesNo,
    winner: finished ? sortedPlayers[0] : null
  };
}
