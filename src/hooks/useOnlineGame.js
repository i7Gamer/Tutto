import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { calculateNextTurn, calculateUndo, getLeaders } from '../utils/coreGameEngine';

let socket;

export function useOnlineGame(deviceId) {
  const [gameState, setGameState] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [error, setError] = useState(null);
  const [myName, setMyName] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);

  const [showRollDiceOption, setShowRollDiceOption] = useState(() => {
    const stored = localStorage.getItem('tutto_showRollDice');
    return stored !== 'false';
  });

  const handleSetShowRollDice = (val) => {
    setShowRollDiceOption(val);
    localStorage.setItem('tutto_showRollDice', val);
  };

  // Turn timer ref and state
  const [turnTimeRemaining, setTurnTimeRemaining] = useState(null);
  const timerIntervalRef = useRef(null);

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
      setGameState(prevState => {
        // Check for host settings changes
        if (prevState && prevState.status === 'lobby' && state.status === 'lobby') {
          if (prevState.winningScore !== state.winningScore) setToastMessage(`Host changed winning score to ${state.winningScore}`);
          if (prevState.turnDuration !== state.turnDuration) setToastMessage(`Host changed turn timer to ${state.turnDuration === 0 ? 'Disabled' : state.turnDuration + 's'}`);
          if (prevState.reconnectTimeout !== state.reconnectTimeout) setToastMessage(`Host changed reconnect timeout to ${state.reconnectTimeout}s`);
        }
        return state;
      });
    });

    socket.on('playerDisconnected', (name) => {
      setToastMessage(`${name} disconnected! They have ${gameState?.reconnectTimeout || 60} seconds to reconnect.`);
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
      socket.off('playerDisconnected');
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

  useEffect(() => {
    if (gameState && !gameState.finished && gameState.status === 'playing') {
      if (gameState.turnDuration > 0) {
        let multiplier = 1;
        if (gameState.currentCard === 'Feuerwerk') multiplier = 3;
        if (gameState.currentCard === 'Kleeblatt') multiplier = 2;
        let targetDuration = gameState.turnDuration * multiplier;

        setTurnTimeRemaining(targetDuration);
        
        if (isHost) {
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          
          let timeLeft = targetDuration;
          timerIntervalRef.current = setInterval(() => {
            timeLeft--;
            setTurnTimeRemaining(timeLeft);
            if (timeLeft <= 0) {
              clearInterval(timerIntervalRef.current);
              // Auto bust!
              nextTurn(0, false);
            }
          }, 1000);
        } else {
          // Clients just count down visually, but don't enforce (to avoid race conditions)
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          let timeLeft = targetDuration;
          timerIntervalRef.current = setInterval(() => {
            timeLeft--;
            setTurnTimeRemaining(timeLeft > 0 ? timeLeft : 0);
          }, 1000);
        }
      } else {
        setTurnTimeRemaining(null);
      }
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      setTurnTimeRemaining(null);
    }
    
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [gameState?.currentPlayerIndex, gameState?.status, gameState?.finished, isHost, gameState?.turnDuration, gameState?.currentCard, gameState?.cards?.length]);

  const updateConfig = (winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout) => {
    socket.emit('updateConfig', { roomId, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout });
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
    s.status = 'playing';
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
    s.status = 'lobby';
    s.currentPlayerIndex = null;
    s.gameTimeInSeconds = 0;
    s.round = 1;
    s.currentCard = null;
    pushState(s);
  };

  const nextTurn = (scoreInput, isSuccess = false) => {
    if (!gameState || gameState.finished) return;

    const result = calculateNextTurn(gameState, scoreInput, isSuccess);

    const s = { ...gameState };
    s.players = result.players;
    s.previousCard = result.previousCard;
    s.previousScore = result.previousScore;
    s.previousLeaders = result.previousLeaders;

    if (result.isRoundEnd) {
      s.chartValues.forEach((vals, i) => vals.push(s.players[i].score));
      s.chartLabels.push(s.round);
    }

    if (result.isGameOver) {
      s.finished = true;
      s.currentPlayerIndex = null;
      pushState(s);
    } else {
      s.currentPlayerIndex = result.nextIndex;
      s.round = result.nextRound;
      s.cards = result.newDeck;
      s.currentCard = result.drawnCard;
      pushState(s);
    }
  };

  const undo = () => {
    if (!gameState || !gameState.previousCard || gameState.previousCard === "Stop") return;
    
    const result = calculateUndo(gameState);
    if (!result) return;

    const s = { ...gameState };
    
    if (result.isRoundEndUndo) {
      s.chartValues = s.chartValues.map(vals => vals.slice(0, -1));
      s.chartLabels = s.chartLabels.slice(0, -1);
    }

    s.players = result.players;
    s.currentPlayerIndex = result.nextIndex;
    s.round = result.nextRound;
    s.cards = result.newDeck;
    s.currentCard = result.drawnCard;

    s.previousCard = null;
    s.previousScore = null;
    s.previousLeaders = null;

    pushState(s);
  };

  useEffect(() => {
    let interval = null;
    if (gameState && gameState.currentPlayerIndex !== null && !gameState.finished && gameState.status === 'playing') {
      interval = setInterval(() => {
        setGameState(prev => {
          if(!prev) return prev;
          return {...prev, gameTimeInSeconds: prev.gameTimeInSeconds + 1};
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [gameState?.currentPlayerIndex, gameState?.finished, gameState?.status]);

  const sendStats = (s) => {
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
        busts: me.busts || 0,
        feuerwerkBusts: me.feuerwerkBusts || 0,
        x2Busts: me.x2Busts || 0,
        feuerwerkPointsScored: me.feuerwerkPointsScored || 0,
        x2PointsScored: me.x2PointsScored || 0
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

  if (!gameState) return { 
    socket, 
    joinRoom,
    isOnline: true,
    isHost,
    hostId,
    roomId,
    myName,
    leaveRoom 
  };

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
    
    players: gameState.players,
    sortedPlayers,
    currentPlayerIndex: gameState.currentPlayerIndex,
    currentPlayer: gameState.currentPlayerIndex !== null ? gameState.players[gameState.currentPlayerIndex] : null,
    currentCard: gameState.currentCard,
    cards: gameState.cards,
    round: gameState.round,
    winningScore: gameState.winningScore,
    setWinningScore: (val) => updateConfig(val, gameState.initialCards, gameState.randomOrder, gameState.turnDuration, gameState.reconnectTimeout),
    initialCards: gameState.initialCards,
    setInitialCards: (val) => updateConfig(gameState.winningScore, val, gameState.randomOrder, gameState.turnDuration, gameState.reconnectTimeout),
    randomOrder: gameState.randomOrder,
    setRandomOrder: (val) => updateConfig(gameState.winningScore, gameState.initialCards, val, gameState.turnDuration, gameState.reconnectTimeout),
    turnDuration: gameState.turnDuration !== undefined ? gameState.turnDuration : 120,
    setTurnDuration: (val) => updateConfig(gameState.winningScore, gameState.initialCards, gameState.randomOrder, val, gameState.reconnectTimeout),
    reconnectTimeout: gameState.reconnectTimeout !== undefined ? gameState.reconnectTimeout : 60,
    setReconnectTimeout: (val) => updateConfig(gameState.winningScore, gameState.initialCards, gameState.randomOrder, gameState.turnDuration, val),
    showRollDiceOption,
    setShowRollDiceOption: handleSetShowRollDice,
    gameTimeInSeconds: gameState.gameTimeInSeconds,
    formattedTime: formatTime(gameState.gameTimeInSeconds),
    turnTimeRemaining,
    toastMessage,
    clearToast: () => setToastMessage(null),
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
