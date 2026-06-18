import { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';

let socket;

export function useOnlineGame(deviceId) {
  const [gameState, setGameState] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [myName, setMyName] = useState(null);
  const [socketId, setSocketId] = useState(null);

  useEffect(() => {
    if (!socket) {
      // In production, it connects to the same origin
      socket = io(window.location.origin);
    }
    
    socket.on('gameState', (state) => {
      setGameState(state);
    });

    socket.on('hostId', (hostId) => {
      setIsHost(hostId === socket.id);
    });

    socket.on('connect', () => {
      setSocketId(socket.id);
    });

    return () => {
      socket.off('gameState');
      socket.off('hostId');
      socket.off('connect');
    };
  }, []);

  const pushState = (newState) => {
    setGameState(newState);
    socket.emit('pushState', { roomId, newState });
  };

  const joinRoom = (room, name) => {
    return new Promise((resolve) => {
      socket.emit('joinRoom', { roomId: room, name, deviceId }, (res) => {
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

  const updateConfig = (winningScore, initialCards) => {
    socket.emit('updateConfig', { roomId, winningScore, initialCards });
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
    
    const resetPlayers = s.players.map(p => ({ ...p, score: 0 }));
    s.players = shuffleArray(resetPlayers);
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

    if (s.currentCard === "x2") currentPlayer.timesx2Received++;
    if (s.currentCard === "Feuerwerk") currentPlayer.timesFeuerwerkReceived++;
    if (s.currentCard === "Stop") currentPlayer.timesSkipped++;

    if (s.currentCard === "Kniffel" && isSuccess) {
      turnScore = 2000;
      currentPlayer.timesKniffelCompleted++;
    } else if (s.currentCard === "Kniffel") {
      currentPlayer.timesKniffelFailed++;
    }

    if (s.currentCard === "Kleeblatt" && isSuccess) {
      currentPlayer.score = 999999;
      s.finished = true;
      pushState(s);
      sendStats(s);
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
      sendStats(s);
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

    if (s.currentCard === "Feuerwerk") p.timesFeuerwerkReceived--;
    
    if (s.previousCard === "Plus_Minus" && s.previousLeaders) {
      s.previousLeaders.forEach(pl => {
        let actual = s.players.find(np => np.name === pl.name);
        actual.score += 1000;
        actual.times1000PointsDeducted--;
      });
    }

    if (s.previousCard === "Plus_Minus") {
      if (s.previousScore === 1000) p.timesPlusMinusCompleted--;
      else p.timesPlusMinusFailed--;
    }

    if (s.previousCard === "x2") p.timesx2Received--;
    
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
        pointsDeducted: me.times1000PointsDeducted,
        plusMinusCompleted: me.timesPlusMinusCompleted,
        plusMinusFailed: me.timesPlusMinusFailed,
        kniffelCompleted: me.timesKniffelCompleted,
        kniffelFailed: me.timesKniffelFailed,
        skipped: me.timesSkipped,
        feuerwerkReceived: me.timesFeuerwerkReceived,
        kleeblattFailed: me.timesKleeblattFailed,
        x2Received: me.timesx2Received
      }
    });
  };

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
    roomId,
    myName,
    joinRoom,
    leaveRoom,
    updateConfig,
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
    setWinningScore: (val) => updateConfig(val, gameState.initialCards),
    initialCards: gameState.initialCards,
    setInitialCards: (val) => updateConfig(gameState.winningScore, val),
    gameTimeInSeconds: gameState.gameTimeInSeconds,
    formattedTime: formatTime(gameState.gameTimeInSeconds),
    finished: gameState.finished,
    startGame,
    endGame,
    nextTurn,
    undo,
    previousCard: gameState.previousCard,
    chartValues: gameState.chartValues,
    chartNames: gameState.chartNames,
    chartLabels: gameState.chartLabels,
    currentCardHasInput,
    currentCardHasYesNo,
    winner: gameState.finished ? sortedPlayers[0] : null
  };
}
