import {
  calculateNextTurn,
  calculateUndo,
  shuffleArray,
  buildDeck,
  buildGlobalStatsPayload,
} from '../utils/coreGameEngine';
import { buildTurnKey, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import { MAX_PLAYER_NAME_LENGTH, isNormalizedConfig } from '../utils/configValidation';
import { zeroedPlayerStats } from '../utils/playerStats';
import playerColorsData from '../../playerColors.json';
import { v4 as uuidv4 } from 'uuid';
import type { Player, CoreGameState, Toast, CardType } from '../types';
import { MAX_HISTORY_LOG_SIZE } from '../types';
import { getSocket } from './socketRef';
import type { GameStore, ImmerStateCreator } from './storeTypes';

export const PLAYER_COLORS: string[] = playerColorsData.PLAYER_COLORS;

export const createInitialPlayer = (name: string): Player => ({
  id: uuidv4(),
  name,
  ...zeroedPlayerStats(),
  position: 0,
});

type GameSlice = Pick<GameStore,
  | 'addToast' | 'removeToast' | 'sendReaction' | 'removeReaction'
  | 'addPlayer' | 'removePlayer' | 'reorderPlayers' | 'changePlayerColor' | 'changeMyColor'
  | 'setLiveTurnState' | 'startGame' | 'endGame' | 'nextTurn' | 'undo'
  | 'drawCardMidTurn'
  | 'buildGlobalStatsPayload' | 'setPreGameStats'
>;

// Single source of truth for toast id generation, shared with socketSlice's
// gameState listener — that listener pushes toasts directly onto an Immer
// draft it's already building (mid-producer), so it can't safely call the
// addToast action below (a nested set() call there would be based on a
// pre-producer snapshot and get lost when the outer producer commits). This
// stays a plain pure helper, not a store action, so both call sites can use
// it without that hazard.
export const makeToast = (message: string): Toast => ({ id: Date.now() + Math.random(), message });

export const createGameSlice: ImmerStateCreator<GameSlice> = (set, get) => ({
  addToast: (message) => set((state) => {
    state.toasts.push(makeToast(message));
  }),
  removeToast: (id) => set((state) => {
    state.toasts = state.toasts.filter(t => t.id !== id);
  }),

  sendReaction: (emoji) => {
    const s = get();
    if (!s.isOnline || !s.roomId) return;
    const socket = getSocket();
    if (socket) socket.emit('sendReaction', { emoji });
  },
  removeReaction: (id) => set((state) => {
    state.reactions = state.reactions.filter(r => r.id !== id);
  }),

  addPlayer: (name) => {
    set((state) => {
      // The store enforces its own roster invariants (mirroring LocalLobby's
      // pre-checks and the server's joinRoom rules) instead of trusting every
      // caller: a case-insensitive duplicate breaks each name-keyed lookup
      // (Plus/Minus deduction, undo, pushState merging) and would make
      // persistence.hasUniquePlayerNames silently drop the entire restored
      // save on the next reload.
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_PLAYER_NAME_LENGTH) return;
      if (state.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) return;
      const usedColors = state.players.map(p => p.color);
      let color = PLAYER_COLORS.find(c => !usedColors.includes(c));
      if (!color) color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
      const newPlayer = createInitialPlayer(trimmed);
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
        turnKey: buildTurnKey(s.roomId, s.round, s.currentPlayerIndex, s.currentCard, s.ruleset),
      };
      localStorage.setItem(DICE_TURN_STATE_KEY, JSON.stringify(snapshotWithPlayer));
    }
    if (get().isOnline) get().pushLiveTurnState(snapshot);
  },

  startGame: () => {
    const s = get();
    if (s.isOnline && !s.isHost) return;

    set((state) => {
      const resetPlayers = state.players.map(p => ({
        ...createInitialPlayer(p.name),
        // createInitialPlayer mints a fresh id on every call — override it
        // with the player's existing one so a restart doesn't hand out a new
        // identity for the same seat (breaking React's reconciliation across
        // the reset, same as color/socketId/disconnected below).
        id: p.id,
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
      state.previousHighestFeuerwerkTurnScore = 0;
      state.previousHighestX2TurnScore = 0;
      state.previousPlayerName = null;
      state.previousTurnSummary = null;
      state.status = 'playing';

      // Same constrained shuffle the mid-game rebuilds use (see buildDeck) —
      // a plain shuffle here could open the game with a 4+ run of one card.
      const deck = buildDeck(state.initialCards);
      state.currentCard = deck.shift() ?? null;
      state.cards = deck;
      state.currentPlayerIndex = 0;
      state.liveTurnState = null;
      state.historyLog = [];
    });
    localStorage.removeItem(DICE_TURN_STATE_KEY);

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
      previousHighestFeuerwerkTurnScore: 0,
      previousHighestX2TurnScore: 0,
      previousPlayerName: null,
      previousTurnSummary: null,
      chartValues: [],
      chartNames: [],
      chartLabels: [],
      historyLog: [],
    });
    localStorage.removeItem(DICE_TURN_STATE_KEY);
    if (get().isOnline) get().pushState();
  },

  // Classic chains only: the active player reveals the next card mid-turn
  // after a tutto. Same reshuffle rule as calculateNextTurn's next-player
  // draw. The server side already works — the active player may push
  // currentCard/cards, and the timer restarts on the card change.
  drawCardMidTurn: (): CardType | null => {
    const s = get();
    if (s.finished || s.currentPlayerIndex === null) return null;
    let deck = [...s.cards];
    if (deck.length === 0) deck = buildDeck(s.initialCards);
    const drawn = deck.shift() ?? null;
    if (!drawn) return null;
    set((state) => {
      state.cards = deck;
      state.currentCard = drawn;
    });
    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    }
    return drawn;
  },

  nextTurn: (scoreInput, isSuccess = false, turnSummary) => {
    const s = get();
    if (s.finished) return;
    if (s.currentPlayerIndex === null) return;

    const result = calculateNextTurn(
      s as CoreGameState & { currentPlayerIndex: number },
      scoreInput,
      isSuccess,
      turnSummary,
    );

    set((state) => {
      state.previousCard = result.previousCard;
      state.previousScore = result.previousScore;
      state.previousLeaders = result.previousLeaders;
      state.previousWasBust = result.previousWasBust;
      state.previousHighestTurnScore = result.previousHighestTurnScore;
      state.previousHighestFeuerwerkTurnScore = result.previousHighestFeuerwerkTurnScore;
      state.previousHighestX2TurnScore = result.previousHighestX2TurnScore;
      state.previousPlayerName = result.previousPlayerName;
      state.previousTurnSummary = result.previousTurnSummary;

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
      state.historyLog.push(result.historyEntry);
      if (state.historyLog.length > MAX_HISTORY_LOG_SIZE) {
        state.historyLog.shift();
      }
    });
    localStorage.removeItem(DICE_TURN_STATE_KEY);

    // Stats are intentionally only tracked for online games. Local games do not
    // submit statistics — by design, not an oversight.
    if (get().isOnline) {
      get().pushState();
      // Only AFTER pushState: the server refuses end-game stats until it has
      // seen finished=true, and socket.io preserves per-connection event
      // order — pushing first is what makes the winner's own submission land.
      if (get().finished) get().sendOnlineStats();
      get().syncOnlineTimers();
    }
  },

  undo: () => {
    const s = get();
    // A chain that ended on a drawn Stop card is a real committed turn and
    // stays undoable — only the bare modernized Stop (nothing happened) is not.
    if (!s.previousCard || (s.previousCard === 'Stop' && !s.previousTurnSummary)) return;

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
      state.previousHighestFeuerwerkTurnScore = 0;
      state.previousHighestX2TurnScore = 0;
      state.previousPlayerName = null;
      state.previousTurnSummary = null;
      // The turn being undone may have been mid-roll (digital dice) — its
      // snapshot no longer corresponds to anything once the score is reverted
      // and the turn reassigned, so it must not keep showing to spectators.
      state.liveTurnState = null;
      if (state.historyLog) {
        state.historyLog.pop();
      }
    });
    localStorage.removeItem(DICE_TURN_STATE_KEY);

    if (get().isOnline) {
      get().pushState();
      get().syncOnlineTimers();
    }
  },

  buildGlobalStatsPayload: () => {
    const s = get();
    // Advisory only: the server recomputes this from the room state it froze at
    // kickoff and overrides whatever arrives here (see socketStatsHandlers.ts).
    return buildGlobalStatsPayload(s.players, s.gameTimeInSeconds, isNormalizedConfig(s), s.round);
  },

  setPreGameStats: (stats) => set({ preGameStats: stats }),
});
