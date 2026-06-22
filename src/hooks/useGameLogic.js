import { useState, useEffect, useCallback } from 'react';
import { calculateNextTurn, calculateUndo, getLeaders, buildGlobalStatsPayload, buildDeck, shuffleArray } from '../utils/coreGameEngine';

export const PLAYER_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33'
];

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
  feuerwerkBusts: 0,
  x2Busts: 0,
  feuerwerkPointsScored: 0,
  x2PointsScored: 0,
  position: 0,
});

export function useGameLogic() {
  const [players, setPlayers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('players')) || []; } catch { return []; }
  });
  const [initialCards, setInitialCards] = useState(() => {
    try { return JSON.parse(localStorage.getItem('initialCards')) || INITIAL_CARDS; } catch { return INITIAL_CARDS; }
  });
  const [cards, setCards] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cards')) || []; } catch { return []; }
  });
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(() => {
    try { const val = localStorage.getItem('currentPlayerIndex'); return (val !== "null" && val !== null) ? JSON.parse(val) : null; } catch { return null; }
  });
  const [currentCard, setCurrentCard] = useState(() => localStorage.getItem('currentCard') || null);
  const [round, setRound] = useState(() => {
    try { return JSON.parse(localStorage.getItem('currentRound')) || 1; } catch { return 1; }
  });
  const [winningScore, setWinningScore] = useState(() => {
    try { return JSON.parse(localStorage.getItem('winningScore')) || 6000; } catch { return 6000; }
  });
  const [finished, setFinished] = useState(() => {
    try { return JSON.parse(localStorage.getItem('finished')) || false; } catch { return false; }
  });
  const [randomOrder, setRandomOrder] = useState(() => {
    try { const val = localStorage.getItem('randomOrder'); return val !== null ? JSON.parse(val) : true; } catch { return true; }
  });
  
  const [showRollDiceOption, setShowRollDiceOption] = useState(() => {
    try { const val = localStorage.getItem('showRollDiceOption'); return val !== null ? JSON.parse(val) : true; } catch { return true; }
  });

  const handleSetShowRollDice = (val) => {
    setShowRollDiceOption(val);
    localStorage.setItem('showRollDiceOption', JSON.stringify(val));
  };
  
  // Timer
  const [gameTimeInSeconds, setGameTimeInSeconds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('gameTimeInSeconds')) || 0; } catch { return 0; }
  });

  // Undo state
  const [previousScore, setPreviousScore] = useState(null);
  const [previousCard, setPreviousCard] = useState(null);
  const [previousLeaders, setPreviousLeaders] = useState(null);

  // Chart data
  const [chartValues, setChartValues] = useState(() => {
    try { return JSON.parse(localStorage.getItem('chartValues')) || []; } catch { return []; }
  });
  const [chartNames, setChartNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('chartNames')) || []; } catch { return []; }
  });
  const [chartLabels, setChartLabels] = useState(() => {
    try { return JSON.parse(localStorage.getItem('chartLabels')) || []; } catch { return []; }
  });

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
    else localStorage.removeItem('currentCard');
    localStorage.setItem('gameTimeInSeconds', JSON.stringify(gameTimeInSeconds));
    localStorage.setItem('cards', JSON.stringify(cards));
    localStorage.setItem('chartValues', JSON.stringify(chartValues));
    localStorage.setItem('chartNames', JSON.stringify(chartNames));
    localStorage.setItem('chartLabels', JSON.stringify(chartLabels));
    localStorage.setItem('finished', JSON.stringify(finished));
    localStorage.setItem('randomOrder', JSON.stringify(randomOrder));
    localStorage.setItem('showRollDiceOption', JSON.stringify(showRollDiceOption));
    localStorage.setItem('winningScore', JSON.stringify(winningScore));
    localStorage.setItem('initialCards', JSON.stringify(initialCards));
  }, [players, currentPlayerIndex, round, currentCard, gameTimeInSeconds, cards, chartValues, chartNames, chartLabels, finished, randomOrder, showRollDiceOption, winningScore, initialCards]);

  const addPlayer = (name) => {
    setPlayers((prev) => {
      const usedColors = prev.map(p => p.color);
      let color = PLAYER_COLORS.find(c => !usedColors.includes(c));
      if (!color) color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
      
      const newPlayer = createInitialPlayer(name);
      newPlayer.color = color;
      return [...prev, newPlayer];
    });
  };

  const changePlayerColor = (name, color) => {
    setPlayers((prev) => prev.map(p => p.name === name ? { ...p, color } : p));
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
    return buildDeck(deckConfig);
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
    const resetPlayers = players.map(p => ({ ...createInitialPlayer(p.name), color: p.color }));
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

  const sendGlobalStats = (finalPlayers, finalTime, finalCard) => {
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

    const payload = buildGlobalStatsPayload(finalPlayers, finalTime, isDefaultGame);

    fetch('/api/stats/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(console.error);
  };

  const nextTurn = (scoreInput, isSuccess = false) => {
    const result = calculateNextTurn({
      players,
      currentPlayerIndex,
      currentCard,
      round,
      winningScore,
      cards,
      initialCards
    }, scoreInput, isSuccess);

    setPreviousCard(result.previousCard);
    setPreviousScore(result.previousScore);
    setPreviousLeaders(result.previousLeaders);

    if (result.isRoundEnd) {
      recordChartData(result.players);
    }

    setPlayers(result.players);

    if (result.isGameOver) {
      setFinished(true);
      setCurrentPlayerIndex(null);
      sendGlobalStats(result.players, gameTimeInSeconds, result.previousCard);
    } else {
      setCurrentPlayerIndex(result.nextIndex);
      setRound(result.nextRound);
      setCards(result.newDeck);
      setCurrentCard(result.drawnCard);
    }
  };

  const undo = () => {
    const result = calculateUndo({
      players,
      currentPlayerIndex,
      round,
      previousCard,
      previousScore,
      previousLeaders,
      currentCard,
      cards
    });

    if (!result) return;

    if (result.isRoundEndUndo) {
      setChartValues(prev => prev.map(vals => vals.slice(0, -1)));
      setChartLabels(prev => prev.slice(0, -1));
    }

    setPlayers(result.players);
    setCurrentPlayerIndex(result.nextIndex);
    setRound(result.nextRound);
    setCards(result.newDeck);
    setCurrentCard(result.drawnCard);

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
    showRollDiceOption,
    setShowRollDiceOption: handleSetShowRollDice,
    gameTimeInSeconds,
    formattedTime: formatTime(gameTimeInSeconds),
    finished,
    addPlayer,
    removePlayer,
    reorderPlayers,
    changePlayerColor,
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
