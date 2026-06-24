import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { io } from 'socket.io-client';
import { calculateNextTurn, calculateUndo, getLeaders, shuffleArray, buildGlobalStatsPayload } from '../utils/coreGameEngine';

const INITIAL_CARDS = {
  Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
  x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
};

export const PLAYER_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33'
];

const createInitialPlayer = (name) => ({
  name, score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
  timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
  feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
  position: 0,
});

let socket;
let gameTimerInterval = null;
let turnTimerInterval = null;

// Initial local state template
const initialLocalState = {
  players: [],
  currentPlayerIndex: null,
  currentCard: null,
  cards: [],
  round: 1,
  winningScore: 6000,
  initialCards: INITIAL_CARDS,
  diceMode: 'physical', // 'physical' or 'digital'
  randomOrder: true,
  turnDuration: 120,
  reconnectTimeout: 60,
  finished: false,
  gameStartTime: null,
  gameTimeInSeconds: 0,
  turnTimeRemaining: null,
  previousScore: null,
  previousCard: null,
  previousLeaders: null,
  previousWasBust: false,
  previousHighestTurnScore: 0,
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  status: 'lobby'
};

export const useGameStore = create(immer((set, get) => ({
  mode: 'local',
  deviceId: null,
  isOnline: false,
  showReconnectPopup: false,
  roomId: null,
  isHost: false,
  hostId: null,
  myName: null,
  toasts: [],

  // Load from localStorage for local mode
  ...initialLocalState,
  
  reset: () => {
    set({
      ...initialLocalState,
      mode: 'local',
      isOnline: false,
      roomId: null,
      isHost: false,
      hostId: null,
      myName: null,
      toasts: [],
      showReconnectPopup: false,
      pendingReconnectSession: null
    });
  },

  cancelReconnect: () => {
    set({
      showReconnectPopup: false,
      roomId: null,
      isHost: false,
      hostId: null,
      myName: null
    });
  },

  clearPendingReconnect: () => {
    sessionStorage.removeItem('tutto_online_session');
    set({ pendingReconnectSession: null });
  },

  init: (deviceId) => {
    let parsed = null;
    try {
      const stored = localStorage.getItem('tutto_local_game');
      if (stored) {
        parsed = JSON.parse(stored);
      }
    } catch (e) {}

    set((state) => {
      state.deviceId = deviceId;
      if (parsed) {
        Object.assign(state, parsed);
      }
      
      try {
        const session = sessionStorage.getItem('tutto_online_session');
        if (session) {
          state.pendingReconnectSession = JSON.parse(session);
        }
      } catch (e) {}
    });

    // Load visual settings
    const storedDiceMode = localStorage.getItem('tutto_diceMode');
    if (storedDiceMode) {
      set({ diceMode: storedDiceMode });
    }
  },

  setMode: (mode) => {
    let parsed = null;
    if (mode === 'local') {
      try {
        const stored = localStorage.getItem('tutto_local_game');
        if (stored) parsed = JSON.parse(stored);
      } catch (e) {}
    }

    set((state) => {
      state.mode = mode;
      state.isOnline = mode === 'online';
      if (mode === 'local' && parsed) {
        Object.assign(state, parsed);
      }
    });
    
    if (mode === 'local') {
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      get().stopOnlineTimers();
      get().startLocalTimers();
    } else {
      get().stopLocalTimers();
    }
  },

  addToast: (message) => set((state) => {
    state.toasts.push({ id: Date.now() + Math.random(), message });
  }),
  removeToast: (id) => set((state) => {
    state.toasts = state.toasts.filter(t => t.id !== id);
  }),

  // --- SETTINGS ---
  setDiceMode: (val) => {
    set({ diceMode: val });
    localStorage.setItem('tutto_diceMode', val);
  },
  
  updateConfig: (config) => {
    set((state) => {
      Object.assign(state, config);
    });
    const s = get();
    if (s.isOnline && s.isHost && s.roomId) {
      socket.emit('updateConfig', { 
        roomId: s.roomId, 
        winningScore: s.winningScore, 
        initialCards: s.initialCards, 
        randomOrder: s.randomOrder, 
        turnDuration: s.turnDuration, 
        reconnectTimeout: s.reconnectTimeout 
      });
    }
  },

  setWinningScore: (val) => get().updateConfig({ winningScore: val }),
  setInitialCards: (val) => get().updateConfig({ initialCards: val }),
  setRandomOrder: (val) => get().updateConfig({ randomOrder: val }),
  setTurnDuration: (val) => get().updateConfig({ turnDuration: val }),
  setReconnectTimeout: (val) => get().updateConfig({ reconnectTimeout: val }),

  // --- LOBBY & PLAYERS ---
  addPlayer: (name) => {
    set((state) => {
      const usedColors = state.players.map(p => p.color);
      let color = PLAYER_COLORS.find(c => !usedColors.includes(c));
      if (!color) color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
      
      const newPlayer = createInitialPlayer(name);
      newPlayer.color = color;
      state.players.push(newPlayer);
    });
  },

  removePlayer: (name) => {
    set((state) => {
      state.players = state.players.filter(p => p.name !== name);
    });
  },

  reorderPlayers: (newPlayers) => {
    set({ players: newPlayers, randomOrder: false });
    if (get().isOnline && get().isHost) {
      socket.emit('reorderPlayers', { roomId: get().roomId, newPlayers });
    }
  },

  changePlayerColor: (name, color) => {
    set((state) => {
      const p = state.players.find(p => p.name === name);
      if (p) p.color = color;
    });
  },

  changeMyColor: (newColor) => {
    localStorage.setItem('tutto_color', newColor);
    get().changePlayerColor(get().myName, newColor);
    if (get().isOnline) {
      socket.emit('updatePlayerColor', { roomId: get().roomId, color: newColor });
    }
  },

  // --- ONLINE SYNC ---
  connectSocket: (url) => {
    if (!socket) {
      socket = io(url || window.location.origin);

      socket.on('gameState', (state) => {
        const wasFinished = get().finished;
        set((prev) => {
          if (prev.mode === 'online' && prev.status === 'lobby' && state.status === 'lobby') {
            if (prev.winningScore !== state.winningScore) prev.toasts.push({ id: Date.now()+Math.random(), message: `Winning score: ${state.winningScore}` });
            if (prev.turnDuration !== state.turnDuration) prev.toasts.push({ id: Date.now()+Math.random(), message: `Turn timer: ${state.turnDuration === 0 ? 'Off' : state.turnDuration + 's'}` });
            if (prev.reconnectTimeout !== state.reconnectTimeout) prev.toasts.push({ id: Date.now()+Math.random(), message: `Kick timer: ${state.reconnectTimeout}s` });
            if (JSON.stringify(prev.initialCards) !== JSON.stringify(state.initialCards)) prev.toasts.push({ id: Date.now()+Math.random(), message: `Deck composition changed` });
          }
          if (prev.mode === 'online' && prev.status === 'playing' && state.status === 'lobby' && !prev.finished) {
            prev.toasts.push({ id: Date.now()+Math.random(), message: "Host ended game early" });
          }
          // Merge state but keep connection-specific fields untouched
          Object.assign(prev, state);
        });
        get().syncOnlineTimers();
        
        if (!wasFinished && get().finished) {
          get().sendOnlineStats();
        }
      });

      socket.on('playerDisconnected', (name) => {
        const seconds = get().reconnectTimeout || 60;
        get().addToast(`${name} disconnected! They have ${seconds} seconds to reconnect.`);
      });

      socket.on('hostId', (hostSocketId) => {
        set({ isHost: hostSocketId === socket.id, hostId: hostSocketId });
      });

      socket.on('kicked', () => {
        get().addToast("You were kicked by the host");
        set({ roomId: null, isHost: false, hostId: null, myName: null });
        sessionStorage.removeItem('tutto_online_session');
        get().setMode('local');
      });

      socket.on('disconnect', () => {
        if (get().mode === 'online') {
          set({ showReconnectPopup: true });
        }
      });

      socket.on('connect', () => {
        set({ showReconnectPopup: false });
        const { roomId, myName, deviceId } = get();
        if (roomId && myName) {
          const savedColor = localStorage.getItem('tutto_color') || null;
          socket.emit('joinRoom', { roomId, name: myName, deviceId, color: savedColor }, (res) => {
            if (res.success) set({ isHost: res.isHost });
          });
        }
      });
    }
  },

  joinRoom: (room, name) => {
    return new Promise((resolve) => {
      get().connectSocket();
      const savedColor = localStorage.getItem('tutto_color') || null;
      socket.emit('joinRoom', { roomId: room, name, deviceId: get().deviceId, color: savedColor }, (res) => {
        if (res.success) {
          set({ roomId: room, isHost: res.isHost, myName: name, mode: 'online', isOnline: true });
          sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: room, myName: name }));
        }
        resolve(res);
      });
    });
  },

  leaveRoom: () => {
    if (socket) socket.emit('leaveRoom');
    get().stopOnlineTimers();
    sessionStorage.removeItem('tutto_online_session');
    set({ 
      players: [],
      currentPlayerIndex: null,
      currentCard: null,
      cards: [],
      round: 1,
      finished: false,
      status: 'lobby',
      roomId: null, 
      isHost: false, 
      myName: null, 
      mode: 'online', 
      isOnline: true 
    });
  },

  kickPlayer: (targetSocketId) => {
    if (get().isHost && socket) socket.emit('kickPlayer', targetSocketId);
  },

  pushState: () => {
    const s = get();
    if (s.isOnline && socket) {
      // Pick game state fields to push
      const { players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds, previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore, chartValues, chartNames, chartLabels, status } = s;
      socket.emit('pushState', { 
        roomId: s.roomId, 
        newState: { players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds, previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore, chartValues, chartNames, chartLabels, status }
      });
    }
  },

  // --- TIMERS ---
  startLocalTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = setInterval(() => {
      const state = get();
      if (state.mode === 'local' && state.currentPlayerIndex !== null && !state.finished && state.gameStartTime) {
        set({ gameTimeInSeconds: Math.floor((Date.now() - state.gameStartTime) / 1000) });
      }
    }, 1000);
  },

  stopLocalTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
  },

  syncOnlineTimers: () => {
    const state = get();
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    if (turnTimerInterval) clearInterval(turnTimerInterval);

    if (state.mode === 'online' && !state.finished && state.status === 'playing' && state.currentPlayerIndex !== null) {
      gameTimerInterval = setInterval(() => {
        const s = get();
        if (s.gameStartTime) {
          set({ gameTimeInSeconds: Math.floor((Date.now() - s.gameStartTime) / 1000) });
        } else {
          set(draft => { draft.gameTimeInSeconds++ });
        }
      }, 1000);

      if (state.turnDuration > 0) {
        let multiplier = 1;
        if (state.currentCard === 'Feuerwerk') multiplier = 3;
        if (state.currentCard === 'Kleeblatt') multiplier = 2;
        let targetDuration = state.turnDuration * multiplier;
        set({ turnTimeRemaining: targetDuration });

        turnTimerInterval = setInterval(() => {
          const s = get();
          const timeLeft = s.turnTimeRemaining - 1;
          set({ turnTimeRemaining: timeLeft > 0 ? timeLeft : 0 });
          if (timeLeft <= 0 && s.isHost) {
            get().nextTurn(0, false);
          }
        }, 1000);
      } else {
        set({ turnTimeRemaining: null });
      }
    } else {
      set({ turnTimeRemaining: null });
    }
  },

  stopOnlineTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    if (turnTimerInterval) clearInterval(turnTimerInterval);
  },

  // --- GAMEPLAY ---
  startGame: () => {
    const s = get();
    if (s.isOnline && !s.isHost) return;

    set((state) => {
      const resetPlayers = state.players.map(p => ({
        ...createInitialPlayer(p.name), 
        color: p.color,
        socketId: p.socketId,
        deviceId: p.deviceId,
        disconnected: p.disconnected
      }));
      state.players = state.randomOrder ? shuffleArray(resetPlayers) : resetPlayers;
      state.round = 1;
      state.gameStartTime = Date.now();
      state.gameTimeInSeconds = 0;
      state.finished = false;
      state.chartValues = state.players.map(() => []);
      state.chartNames = state.players.map(p => p.name);
      state.chartLabels = [];
      state.previousCard = null;
      state.previousScore = null;
      state.previousLeaders = null;
      state.previousWasBust = false;
      state.previousHighestTurnScore = 0;
      state.status = 'playing';

      const deckConfig = Object.keys(state.initialCards).reduce((acc, card) => {
        for(let i=0; i<state.initialCards[card]; i++) acc.push(card);
        return acc;
      }, []);
      const deck = shuffleArray(deckConfig);
      
      state.currentCard = deck.shift();
      state.cards = deck;
      state.currentPlayerIndex = 0;
    });

    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    } else {
      get().startLocalTimers();
    }
  },

  endGame: () => {
    if (get().isOnline && !get().isHost) return;
    set({
      finished: false,
      status: 'lobby',
      currentPlayerIndex: null,
      gameTimeInSeconds: 0,
      round: 1,
      currentCard: null,
      turnTimeRemaining: null
    });
    if (get().isOnline) get().pushState();
  },

  nextTurn: (scoreInput, isSuccess = false) => {
    const s = get();
    if (s.finished) return;

    const wasFinished = s.finished;
    const result = calculateNextTurn(s, scoreInput, isSuccess);

    set((state) => {
      state.previousCard = result.previousCard;
      state.previousScore = result.previousScore;
      state.previousLeaders = result.previousLeaders;
      state.previousWasBust = result.previousWasBust;
      state.previousHighestTurnScore = result.previousHighestTurnScore;
      
      if (result.isRoundEnd) {
        state.chartValues.forEach((vals, i) => vals.push(result.players[i].score));
        state.chartLabels.push(state.round);
      }
      
      state.players = result.players;

      if (result.isGameOver) {
        state.finished = true;
        state.currentPlayerIndex = null;
        if (state.gameStartTime) {
          state.gameTimeInSeconds = Math.floor((Date.now() - state.gameStartTime) / 1000);
        }
      } else {
        state.currentPlayerIndex = result.nextIndex;
        state.round = result.nextRound;
        state.cards = result.newDeck;
        state.currentCard = result.drawnCard;
      }
    });

    if (!wasFinished && get().finished) {
      if (!get().isOnline) {
        // Send global stats using the updated state
        fetch('/api/stats/global', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tutto-token': 'tutto-local-dev-token' },
          body: JSON.stringify(get().buildGlobalStatsPayload())
        }).catch(console.error);
        
        // Send personal stats for the local device
        const finalState = get();
        const me = finalState.players[0]; // In local games, just save the stats of the first player to the device
        if (me) {
          const leaders = getLeaders(finalState.players);
          const didIWin = leaders.some(l => l.name === me.name) ? 1 : 0;
          
          fetch(`/api/stats/${finalState.deviceId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tutto-token': 'tutto-local-dev-token' },
            body: JSON.stringify({
              gamesPlayed: 1,
              wins: didIWin,
              totalPlaytime: finalState.gameTimeInSeconds,
              pointsDeducted: me.times1000PointsDeducted || 0,
              plusMinusCompleted: me.timesPlusMinusCompleted || 0,
              plusMinusFailed: me.timesPlusMinusFailed || 0,
              kniffelCompleted: me.timesKniffelCompleted || 0,
              kniffelFailed: me.timesKniffelFailed || 0,
              skipped: me.timesSkipped || 0,
              feuerwerkReceived: me.timesFeuerwerkReceived || 0,
              kleeblattFailed: me.timesKleeblattFailed || 0,
              kleeblattCompleted: me.timesKleeblattCompleted || 0,
              x2Received: me.timesx2Received || 0,
              totalTurns: me.totalTurns || 0,
              busts: me.busts || 0,
              feuerwerkBusts: me.feuerwerkBusts || 0,
              x2Busts: me.x2Busts || 0,
              feuerwerkPointsScored: me.feuerwerkPointsScored || 0,
              x2PointsScored: me.x2PointsScored || 0,
              totalScore: me.score || 0,
              highestTurnScore: me.highestTurnScore || 0,
              fastestWinTurns: didIWin ? (me.totalTurns || 0) : null,
              fastestLossTurns: !didIWin ? (me.totalTurns || 0) : null
            })
          }).catch(console.error);
        }
      } else {
        get().sendOnlineStats();
      }
    }

    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    }
  },

  undo: () => {
    const s = get();
    if (!s.previousCard) return;
    if (s.previousCard === "Stop") return;

    const result = calculateUndo(s);
    if (!result) return;

    set((state) => {
      if (result.isRoundEndUndo) {
        state.chartValues = state.chartValues.map(vals => vals.slice(0, -1));
        state.chartLabels = state.chartLabels.slice(0, -1);
      }
      state.players = result.players;
      state.currentPlayerIndex = result.nextIndex;
      state.round = result.nextRound;
      state.cards = result.newDeck;
      state.currentCard = result.drawnCard;
      state.previousCard = null;
      state.previousScore = null;
      state.previousLeaders = null;
      state.previousWasBust = false;
      state.previousHighestTurnScore = 0;
    });

    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    }
  },

  // Helper for local game stats
  buildGlobalStatsPayload: () => {
    const s = get();
    const isDefaultGame = s.winningScore === 6000 && JSON.stringify(s.initialCards) === JSON.stringify(INITIAL_CARDS);
    return buildGlobalStatsPayload(s.players, s.gameTimeInSeconds, isDefaultGame);
  },

  // Helper for online game stats
  sendOnlineStats: () => {
    const s = get();
    const me = s.players.find(p => p.name === s.myName);
    if (me && socket) {
      const leaders = getLeaders(s.players);
      const didIWin = leaders.find(l => l.name === me.name) ? 1 : 0;
      socket.emit('endGameStats', {
        roomId: s.roomId,
        deviceId: s.deviceId,
        stats: {
          gamesPlayed: 1, wins: didIWin, totalPlaytime: s.gameTimeInSeconds || 0,
          pointsDeducted: me.times1000PointsDeducted || 0, plusMinusCompleted: me.timesPlusMinusCompleted || 0,
          plusMinusFailed: me.timesPlusMinusFailed || 0, kniffelCompleted: me.timesKniffelCompleted || 0,
          kniffelFailed: me.timesKniffelFailed || 0, skipped: me.timesSkipped || 0,
          feuerwerkReceived: me.timesFeuerwerkReceived || 0, kleeblattFailed: me.timesKleeblattFailed || 0,
          kleeblattCompleted: me.timesKleeblattCompleted || 0, x2Received: me.timesx2Received,
          totalTurns: me.totalTurns || 0, busts: me.busts || 0,
          feuerwerkBusts: me.feuerwerkBusts || 0, x2Busts: me.x2Busts || 0,
          feuerwerkPointsScored: me.feuerwerkPointsScored || 0, x2PointsScored: me.x2PointsScored || 0,
          highestTurnScore: me.highestTurnScore || 0,
          totalScore: me.score || 0,
          fastestWinTurns: didIWin ? (me.totalTurns || 0) : null,
          fastestLossTurns: !didIWin ? (me.totalTurns || 0) : null
        }
      });
    }

    if (s.isHost) {
      fetch('/api/stats/global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tutto-token': 'tutto-local-dev-token' },
        body: JSON.stringify(get().buildGlobalStatsPayload())
      }).catch(console.error);
    }
  }

})));

// Subscribe to automatically save local state to localStorage
useGameStore.subscribe((state) => {
  if (state.mode === 'local') {
    const localStateToSave = {
      players: state.players,
      currentPlayerIndex: state.currentPlayerIndex,
      currentCard: state.currentCard,
      cards: state.cards,
      round: state.round,
      winningScore: state.winningScore,
      diceMode: state.diceMode,
      initialCards: state.initialCards,
      randomOrder: state.randomOrder,
      turnDuration: state.turnDuration,
      reconnectTimeout: state.reconnectTimeout,
      finished: state.finished,
      gameTimeInSeconds: state.gameTimeInSeconds,
      previousScore: state.previousScore,
      previousCard: state.previousCard,
      previousLeaders: state.previousLeaders,
      chartValues: state.chartValues,
      chartNames: state.chartNames,
      chartLabels: state.chartLabels,
      status: state.status
    };
    localStorage.setItem('tutto_local_game', JSON.stringify(localStateToSave));
  }
});
