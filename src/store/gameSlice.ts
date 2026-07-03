import {
  calculateNextTurn,
  calculateUndo,
  shuffleArray,
  buildGlobalStatsPayload,
} from '../utils/coreGameEngine';
import { buildTurnKey } from '../utils/diceTurnState';
import { DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE } from '../utils/configValidation';
import playerColorsData from '../../playerColors.json';
import type { CardType, Player, CoreGameState } from '../types';
import { getSocket } from './socketRef';
import type { GameStore, ImmerStateCreator } from './storeTypes';

export const PLAYER_COLORS: string[] = playerColorsData.PLAYER_COLORS;

export const createInitialPlayer = (name: string): Player => ({
  name, score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
  timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
  feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
  position: 0,
});

type GameSlice = Pick<GameStore,
  | 'addToast' | 'removeToast'
  | 'addPlayer' | 'removePlayer' | 'reorderPlayers' | 'changePlayerColor' | 'changeMyColor'
  | 'setLiveTurnState' | 'startGame' | 'endGame' | 'nextTurn' | 'undo'
  | 'buildGlobalStatsPayload'
>;

export const createGameSlice: ImmerStateCreator<GameSlice> = (set, get) => ({
  addToast: (message) => set((state) => {
    state.toasts.push({ id: Date.now() + Math.random(), message });
  }),
  removeToast: (id) => set((state) => {
    state.toasts = state.toasts.filter(t => t.id !== id);
  }),

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
    set((state) => { state.players = state.players.filter(p => p.name !== name); });
  },

  reorderPlayers: (newPlayers) => {
    set({ players: newPlayers, randomOrder: false });
    const socket = getSocket();
    if (get().isOnline && get().isHost && socket) {
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
    get().changePlayerColor(get().myName ?? '', newColor);
    const socket = getSocket();
    if (get().isOnline && socket) {
      socket.emit('updatePlayerColor', { roomId: get().roomId, color: newColor });
    }
  },

  setLiveTurnState: (snapshot) => {
    set({ liveTurnState: snapshot });
    if (snapshot) {
      const s = get();
      const snapshotWithPlayer = {
        ...snapshot,
        playerName: s.currentPlayerIndex !== null ? s.players[s.currentPlayerIndex]?.name : undefined,
        // Stamped so a later restore (see DiceGame's mount effect) can tell this
        // turn apart from a stale snapshot left behind by an earlier turn — e.g.
        // one the server's turn timer advanced past while this player was
        // disconnected, which never got the chance to clear its own cache entry.
        turnKey: buildTurnKey(s.roomId, s.round, s.currentPlayerIndex, s.currentCard),
      };
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify(snapshotWithPlayer));
    }
    if (get().isOnline) get().pushState();
  },

  startGame: () => {
    const s = get();
    if (s.isOnline && !s.isHost) return;

    set((state) => {
      const resetPlayers = state.players.map(p => ({
        ...createInitialPlayer(p.name),
        color: p.color,
        socketId: p.socketId,
        disconnected: p.disconnected,
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

      const deck = shuffleArray(
        (Object.keys(state.initialCards) as CardType[]).flatMap(card =>
          Array.from({ length: state.initialCards[card] ?? 0 }, (): CardType => card)
        )
      );
      state.currentCard = deck.shift() ?? null;
      state.cards = deck;
      state.currentPlayerIndex = 0;
      state.liveTurnState = null;
    });
    localStorage.removeItem('tutto_dice_turn_state');

    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    } else {
      get().startLocalTimers();
    }
  },

  endGame: () => {
    if (get().isOnline && !get().isHost) return;
    get().stopLocalTimers();
    set({
      finished: false,
      status: 'lobby',
      currentPlayerIndex: null,
      gameTimeInSeconds: 0,
      round: 1,
      currentCard: null,
      cards: [],
      turnTimeRemaining: null,
      liveTurnState: null,
      previousCard: null,
      previousScore: null,
      previousLeaders: null,
      previousWasBust: false,
      previousHighestTurnScore: 0,
      chartValues: [],
      chartNames: [],
      chartLabels: [],
    });
    localStorage.removeItem('tutto_dice_turn_state');
    if (get().isOnline) get().pushState();
  },

  nextTurn: (scoreInput, isSuccess = false) => {
    const s = get();
    if (s.finished) return;
    if (s.currentPlayerIndex === null) return;

    const result = calculateNextTurn(
      s as CoreGameState & { currentPlayerIndex: number },
      scoreInput,
      isSuccess,
    );

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
      state.liveTurnState = null;
      localStorage.removeItem('tutto_dice_turn_state');
    });

    // Stats are intentionally only tracked for online games. Local games do not
    // submit statistics — by design, not an oversight.
    if (get().finished && get().isOnline) get().sendOnlineStats();
    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    }
  },

  undo: () => {
    const s = get();
    if (!s.previousCard || s.previousCard === 'Stop') return;

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

  buildGlobalStatsPayload: () => {
    const s = get();
    const isDefaultGame = s.winningScore === DEFAULT_WINNING_SCORE && JSON.stringify(s.initialCards) === JSON.stringify(DEFAULT_INITIAL_CARDS);
    return buildGlobalStatsPayload(s.players, s.gameTimeInSeconds, isDefaultGame);
  },
});
