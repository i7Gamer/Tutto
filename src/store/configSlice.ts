import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
} from '../utils/configValidation';
import { getSocket } from './socketRef';
import type { GameStore, ImmerStateCreator } from './storeTypes';

type ConfigSlice = Pick<GameStore,
  | 'setDiceMode' | 'setAudioEnabled'
  | 'updateConfig' | 'setWinningScore' | 'setInitialCards' | 'setRandomOrder'
  | 'setTurnDuration' | 'setReconnectTimeout' | 'resetGeneralSettings' | 'resetInitialCards'
>;

export const createConfigSlice: ImmerStateCreator<ConfigSlice> = (set, get) => ({
  setDiceMode: (val) => {
    set({ diceMode: val });
    localStorage.setItem('tutto_diceMode', val);
  },

  setAudioEnabled: (val) => {
    set({ audioEnabled: val });
    localStorage.setItem('tutto_audioEnabled', String(val));
  },

  updateConfig: (config) => {
    set((state) => { Object.assign(state, config); });
    const s = get();
    const socket = getSocket();
    if (s.isOnline && s.isHost && s.roomId && socket) {
      socket.emit('updateConfig', {
        roomId: s.roomId,
        winningScore: s.winningScore,
        initialCards: s.initialCards,
        randomOrder: s.randomOrder,
        turnDuration: s.turnDuration,
        reconnectTimeout: s.reconnectTimeout,
      });
    }
  },

  setWinningScore: (val) => get().updateConfig({ winningScore: val }),
  setInitialCards: (val) => get().updateConfig({ initialCards: val }),
  setRandomOrder: (val) => get().updateConfig({ randomOrder: val }),
  setTurnDuration: (val) => get().updateConfig({ turnDuration: val }),
  setReconnectTimeout: (val) => get().updateConfig({ reconnectTimeout: val }),
  resetGeneralSettings: () => get().updateConfig({
    winningScore: DEFAULT_WINNING_SCORE,
    randomOrder: true,
    turnDuration: DEFAULT_TURN_DURATION,
    reconnectTimeout: DEFAULT_RECONNECT_TIMEOUT,
  }),
  resetInitialCards: () => get().updateConfig({ initialCards: { ...DEFAULT_INITIAL_CARDS } }),
});
