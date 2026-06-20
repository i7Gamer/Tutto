import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';

let socket;

export function useOnlineGame(deviceId) {
  const [gameState, setGameState] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [myName, setMyName] = useState(null);
  const [socketId, setSocketId] = useState(null);

  const roomRef = useRef(null);
  const nameRef = useRef(null);
  
  useEffect(() => {
    roomRef.current = roomId;
    nameRef.current = myName;
  }, [roomId, myName]);

  useEffect(() => {
    if (!socket) {
      // In production, it connects to the same origin
      socket = io(window.location.origin);
    }
    
    socket.on('gameState', (state) => {
      setGameState(state);
    });

    socket.on('hostId', (hostSocketId) => {
      setIsHost(hostSocketId === socket.id);
      setHostId(hostSocketId);
    });

    socket.on('kicked', () => {
      alert("You were kicked from the room by the host.");
      setRoomId(null);
      setGameState(null);
      setIsHost(false);
      setHostId(null);
      setMyName(null);
    });

    socket.on('connect', () => {
      setSocketId(socket.id);
      if (roomRef.current && nameRef.current) {
        // Automatically rejoin if reconnected after a drop
        const savedColor = localStorage.getItem('tutto_color') || null;
        socket.emit('joinRoom', { roomId: roomRef.current, name: nameRef.current, deviceId, color: savedColor }, (res) => {
          if (res.success) {
            setIsHost(res.isHost);
          }
        });
      }
    });

    return () => {
      socket.off('gameState');
      socket.off('hostId');
      socket.off('connect');
      socket.off('kicked');
    };
  }, []);

  const pushState = (newState) => {
    setGameState(newState);
    socket.emit('pushState', { roomId, newState });
  };

  const joinRoom = (room, name) => {
    return new Promise((resolve) => {
      const savedColor = localStorage.getItem('tutto_color') || null;
      socket.emit('joinRoom', { roomId: room, name, deviceId, color: savedColor }, (res) => {
        if (res.success) {
          setRoomId(room);
          setIsHost(res.isHost);
          setMyName(name);
        }
        resolve(res);
      });
    });
  };

  const leaveRoom = () => {
    socket.emit('leaveRoom');
    setRoomId(null);
    setGameState(null);
    setIsHost(false);
    setMyName(null);
  };

  const updateConfig = (winningScore, initialCards, randomOrder) => {
    socket.emit('updateConfig', { roomId, winningScore, initialCards, randomOrder });
  };

  const kickPlayer = (targetSocketId) => {
    if (isHost) {
      socket.emit('kickPlayer', targetSocketId);
    }
  };

  const reorderPlayers = (newPlayers) => {
    if (isHost) {
      socket.emit('reorderPlayers', { roomId, newPlayers });
    }
  };

  const changeMyColor = (newColor) => {
    localStorage.setItem('tutto_color', newColor);
    socket.emit('updatePlayerColor', { roomId, color: newColor });
  };

  const shuffleArray = (array) => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  };

  const shuffleCards = (deckConfig) => {
    const newCards = [];
    Object.keys(deckConfig).forEach(cardType => {
      for (let i = 0; i < deckConfig[cardType]; i++) {
        newCards.push(cardType);
      }
    });
    return shuffleArray(newCards);
  };

  const getLeaders = (currentPlayers) => {
    const sorted = [...currentPlayers].sort((a, b) => b.score - a.score);
    if (!sorted.length) return [];
    const topScore = sorted[0].score;
    return sorted.filter(p => p.score === topScore);
  };

  const startGame = () => {
    if (!isHost) return;
    const s = { ...gameState };
    
    const resetPlayers = s.players.map(p => ({
      ...p,
      score: 0,
      times1000PointsDeducted: 0,
      timesPlusMinusCompleted: 0,
      timesPlusMinusFailed: 0,
      timesKniffelCompleted: 0,
      timesKniffelFailed: 0,
      timesSkipped: 0,
      timesFeuerwerkReceived: 0,
      timesKleeblattFailed: 0,
      timesKleeblattCompleted: 0,
      timesx2Received: 0,
      totalTurns: 0,
      busts: 0,
      feuerwerkBusts: 0,
      x2Busts: 0,
      feuerwerkPointsScored: 0,
      x2PointsScored: 0
    }));
    if (s.randomOrder) {
      s.players = shuffleArray(resetPlayers);
    } else {
      s.players = resetPlayers;
    }
    s.round = 1;
    s.gameTimeInSeconds = 0;
    s.finished = false;
    s.chartValues = s.players.map(() => []);
    s.chartNames = s.players.map(p => p.name);
    s.chartLabels = [];
    s.previousCard = null;
    s.previousScore = null;
    s.previousLeaders = null;

    let deck = shuffleCards(s.initialCards);
    s.currentCard = deck.shift();
    s.cards = deck;
    s.currentPlayerIndex = 0;

    pushState(s);
  };

  const endGame = () => {
    if (!isHost) return;
    const s = { ...gameState };
    s.finished = false;
    s.currentPlayerIndex = null;
    s.gameTimeInSeconds = 0;
    s.round = 1;
    s.currentCard = null;
    pushState(s);
  };

  const nextTurn = (scoreInput, isSuccess = false) => {
    if (!gameState || gameState.finished) return;
    const s = { ...gameState };
    
    let turnScore = scoreInput || 0;
    let currentPlayer = s.players[s.currentPlayerIndex];
    let snapshotLeaders = null;

    // Track turns and busts.
    // Bust = rolled 0 on a dice-input card; Yes/No cards (Plus_Minus, Kniffel, Kleeblatt)
    // have failures, not busts. Stop gives 0 by design.
    currentPlayer.totalTurns = (currentPlayer.totalTurns || 0) + 1;
    const isYesNoCard = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(s.currentCard);
    if (turnScore === 0 && s.currentCard !== "Stop" && !isSuccess && !isYesNoCard) {
      currentPlayer.busts = (currentPlayer.busts || 0) + 1;
      if (s.currentCard === "Feuerwerk") currentPlayer.feuerwerkBusts = (currentPlayer.feuerwerkBusts || 0) + 1;
      if (s.currentCard === "x2") currentPlayer.x2Busts = (currentPlayer.x2Busts || 0) + 1;
    }

    if (s.currentCard === "Plus_Minus" && isSuccess) {
      turnScore = 1000;
      const leaders = getLeaders(s.players);
      const isLeader = leaders.find(l => l.name === currentPlayer.name);
      
      if (!isLeader) {
        snapshotLeaders = leaders.map(l => ({...l}));
        leaders.forEach(l => {
          const p = s.players.find(np => np.name === l.name);
          p.times1000PointsDeducted++;
          p.score -= 1000;
        });
      }
      currentPlayer.timesPlusMinusCompleted++;
    } else if (s.currentCard === "Plus_Minus") {
      currentPlayer.timesPlusMinusFailed++;
    }

    // Bug 4 fix: use currentPlayer (single reference) consistently for x2 and Feuerwerk
    if (s.currentCard === 'x2') {
      currentPlayer.timesx2Received = (currentPlayer.timesx2Received || 0) + 1;
      currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored || 0) + turnScore;
    }
    if (s.currentCard === 'Feuerwerk') {
      currentPlayer.timesFeuerwerkReceived = (currentPlayer.timesFeuerwerkReceived || 0) + 1;
      currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored || 0) + turnScore;
    }
    if (s.currentCard === "Stop") currentPlayer.timesSkipped++;

    if (s.currentCard === "Kniffel" && isSuccess) {
      turnScore = 2000;
      currentPlayer.timesKniffelCompleted++;
    } else if (s.currentCard === "Kniffel") {
      currentPlayer.timesKniffelFailed++;
    }

    if (s.currentCard === "Kleeblatt" && isSuccess) {
      currentPlayer.timesKleeblattCompleted = (currentPlayer.timesKleeblattCompleted || 0) + 1;
      currentPlayer.score = 999999;
      s.finished = true;
      s.currentPlayerIndex = null; // Bug 6 fix
      pushState(s);
      return;
    } else if (s.currentCard === "Kleeblatt") {
      currentPlayer.timesKleeblattFailed++;
    }

    currentPlayer.score += turnScore;
    
    s.previousCard = s.currentCard;
    s.previousScore = turnScore;
    s.previousLeaders = snapshotLeaders;

    let isGameOver = false;
    let nextIndex = s.currentPlayerIndex + 1;

    if (nextIndex >= s.players.length) {
      const currentLeaders = getLeaders(s.players);
      if (currentLeaders[0].score >= s.winningScore) {
        if (currentLeaders.length === 1) {
          isGameOver = true;
          s.chartValues.forEach((vals, i) => vals.push(s.players[i].score));
          s.chartLabels.push(s.round);
        }
      }
      if (!isGameOver) {
        nextIndex = 0;
        s.chartValues.forEach((vals, i) => vals.push(s.players[i].score));
        s.chartLabels.push(s.round);
        s.round++;
      }
    }

    if (isGameOver) {
      s.finished = true;
      s.currentPlayerIndex = null;
      pushState(s);
    } else {
      s.currentPlayerIndex = nextIndex;
      let currentDeck = [...s.cards];
      if (currentDeck.length === 0) {
        currentDeck = shuffleCards(s.initialCards);
      }
      s.currentCard = currentDeck.shift();
      s.cards = currentDeck;
      pushState(s);
    }
  };

  const undo = () => {
    if (!gameState || !gameState.previousCard || gameState.previousCard === "Stop") return;
    const s = { ...gameState };

    let prevIndex = s.currentPlayerIndex - 1;
    
    if (prevIndex < 0) {
      prevIndex = s.players.length - 1;
      s.round--;
      s.chartValues = s.chartValues.map(vals => vals.slice(0, -1));
      s.chartLabels = s.chartLabels.slice(0, -1);
    }

    let p = s.players[prevIndex];

    // Bug 2 fix: check previousCard, not currentCard
    if (s.previousCard === "Feuerwerk") p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived || 0) - 1);

    // Bug 1 fix: reverse totalTurns and bust counters
    p.totalTurns = Math.max(0, (p.totalTurns || 0) - 1);
    const wasYesNoCard = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(s.previousCard);
    if (s.previousScore === 0 && s.previousCard !== "Stop" && !wasYesNoCard) {
      p.busts = Math.max(0, (p.busts || 0) - 1);
      if (s.previousCard === "Feuerwerk") p.feuerwerkBusts = Math.max(0, (p.feuerwerkBusts || 0) - 1);
      if (s.previousCard === "x2") p.x2Busts = Math.max(0, (p.x2Busts || 0) - 1);
    }

    // Bug 1 fix: reverse special card point counters
    if (s.previousCard === "Feuerwerk") {
      p.feuerwerkPointsScored = Math.max(0, (p.feuerwerkPointsScored || 0) - s.previousScore);
    }
    if (s.previousCard === "x2") {
      p.x2PointsScored = Math.max(0, (p.x2PointsScored || 0) - s.previousScore);
    }
    
    if (s.previousCard === "Plus_Minus" && s.previousLeaders) {
      s.previousLeaders.forEach(pl => {
        let actual = s.players.find(np => np.name === pl.name);
        actual.score = pl.score;
        actual.times1000PointsDeducted--;
      });
    }

    if (s.previousCard === "Plus_Minus") {
      if (s.previousScore === 1000) p.timesPlusMinusCompleted--;
      else p.timesPlusMinusFailed--;
    }

    if (s.previousCard === "x2") p.timesx2Received = Math.max(0, (p.timesx2Received || 0) - 1);
    
    if (s.previousCard === "Kniffel") {
      if (s.previousScore === 2000) p.timesKniffelCompleted--;
      else p.timesKniffelFailed--;
    }

    p.score -= s.previousScore;

    s.currentPlayerIndex = prevIndex;
    s.cards = [s.currentCard, ...s.cards];
    s.currentCard = s.previousCard;
    
    s.previousCard = null;
    s.previousScore = null;
    s.previousLeaders = null;

    pushState(s);
  };

  // Timer handled by server or client? Just let client handle its own visual timer
  useEffect(() => {
    let interval = null;
    if (gameState && gameState.currentPlayerIndex !== null && !gameState.finished && isHost) {
      interval = setInterval(() => {
        setGameState(prev => {
          if(!prev) return prev;
          const updated = {...prev, gameTimeInSeconds: prev.gameTimeInSeconds + 1};
          // Don't push state every second to avoid flooding. Let it sync occasionally.
          // Wait, other clients won't see timer tick unless pushed.
          // Better: pushState only on actions, but all clients run the timer locally if playing!
          return updated;
        });
      }, 1000);
    } else if (gameState && gameState.currentPlayerIndex !== null && !gameState.finished && !isHost) {
      interval = setInterval(() => {
        setGameState(prev => {
          if(!prev) return prev;
          return {...prev, gameTimeInSeconds: prev.gameTimeInSeconds + 1};
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [gameState?.currentPlayerIndex, gameState?.finished, isHost]);

  const sendStats = (s) => {
    // Only send for our own device
    const me = s.players.find(p => p.name === myName);
    if (!me) return;

    const leaders = getLeaders(s.players);
    const didIWin = leaders.find(l => l.name === me.name) ? 1 : 0;

    socket.emit('endGameStats', {
      roomId,
      deviceId,
      stats: {
        gamesPlayed: 1,
        wins: didIWin,
        totalPlaytime: s.gameTimeInSeconds,
        pointsDeducted: me.times1000PointsDeducted,
        plusMinusCompleted: me.timesPlusMinusCompleted,
        plusMinusFailed: me.timesPlusMinusFailed,
        kniffelCompleted: me.timesKniffelCompleted,
        kniffelFailed: me.timesKniffelFailed,
        skipped: me.timesSkipped,
        feuerwerkReceived: me.timesFeuerwerkReceived,
        kleeblattFailed: me.timesKleeblattFailed,
        kleeblattCompleted: me.timesKleeblattCompleted || 0,
        x2Received: me.timesx2Received,
        totalTurns: me.totalTurns || 0,
        busts: me.busts || 0
      }
    });

    if (isHost) {
      let totalPlusMinus = 0, totalKniffel = 0, totalStop = 0, totalFeuerwerk = 0, totalKleeblatt = 0, totalKleeblattCompleted = 0, totalx2 = 0;
      let totalTurns = 0, totalScore = 0;
      let totalPlusMinusCompleted = 0, totalKniffelCompleted = 0;
      let totalFeuerwerkPoints = 0, totalx2Points = 0;
      let totalFeuerwerkBusts = 0, totalx2Busts = 0, totalBusts = 0;
      s.players.forEach(p => {
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
        totalFeuerwerkBusts += (p.feuerwerkBusts || 0);
        totalx2Busts += (p.x2Busts || 0);
        totalBusts += (p.busts || 0);
      });

      const isDefaultGame = (() => {
        if (s.winningScore !== 6000) return false;
        const INITIAL_CARDS = {
          Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
          x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5
        };
        for (const key in INITIAL_CARDS) {
          if (s.initialCards[key] !== INITIAL_CARDS[key]) return false;
        }
        for (const key in s.initialCards) {
          if (s.initialCards[key] !== INITIAL_CARDS[key]) return false;
        }
        return true;
      })();

      fetch('/api/stats/global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gamesPlayed: 1,
          totalPlaytime: s.gameTimeInSeconds,
          totalPlusMinus, totalKniffel, totalStop, totalFeuerwerk, totalKleeblatt, totalKleeblattCompleted, totalx2,
          totalTurns, totalScore, totalPlusMinusCompleted, totalKniffelCompleted, totalFeuerwerkPoints, totalx2Points,
          totalFeuerwerkBusts, totalx2Busts, totalBusts,
          isDefaultGame
        })
      }).catch(console.error);
    }
  };

  const hasSentStats = useRef(false);
  useEffect(() => {
    if (gameState?.finished && !hasSentStats.current) {
      hasSentStats.current = true;
      sendStats(gameState);
    } else if (gameState && !gameState.finished) {
      hasSentStats.current = false;
    }
  }, [gameState?.finished]);

  if (!gameState) return { socket, joinRoom };

  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  };

  const currentCardHasInput = !["Stop", "Plus_Minus", "Kniffel", "Kleeblatt"].includes(gameState.currentCard);
  const currentCardHasYesNo = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(gameState.currentCard);

  const sortedPlayers = [...gameState.players].sort((a, b) => b.score - a.score);
  sortedPlayers.forEach((p, i) => {
    if (i > 0 && p.score === sortedPlayers[i - 1].score) {
      p.position = sortedPlayers[i - 1].position;
    } else {
      p.position = i === 0 ? 1 : sortedPlayers[i - 1].position + 1;
    }
  });

  return {
    isOnline: true,
    isHost,
    hostId,
    roomId,
    myName,
    joinRoom,
    leaveRoom,
    updateConfig,
    kickPlayer,
    reorderPlayers,
    socket,
    
    // Mapping to match useGameLogic
    players: gameState.players,
    sortedPlayers,
    currentPlayerIndex: gameState.currentPlayerIndex,
    currentPlayer: gameState.currentPlayerIndex !== null ? gameState.players[gameState.currentPlayerIndex] : null,
    currentCard: gameState.currentCard,
    cards: gameState.cards,
    round: gameState.round,
    winningScore: gameState.winningScore,
    setWinningScore: (val) => updateConfig(val, gameState.initialCards, gameState.randomOrder),
    initialCards: gameState.initialCards,
    setInitialCards: (val) => updateConfig(gameState.winningScore, val, gameState.randomOrder),
    randomOrder: gameState.randomOrder,
    setRandomOrder: (val) => updateConfig(gameState.winningScore, gameState.initialCards, val),
    gameTimeInSeconds: gameState.gameTimeInSeconds,
    formattedTime: formatTime(gameState.gameTimeInSeconds),
    finished: gameState.finished,
    startGame,
    endGame,
    nextTurn,
    undo,
    changeMyColor,
    previousCard: gameState.previousCard,
    chartValues: gameState.chartValues,
    chartNames: gameState.chartNames,
    chartLabels: gameState.chartLabels,
    currentCardHasInput,
    currentCardHasYesNo,
    winner: gameState.finished ? sortedPlayers[0] : null
  };
}
