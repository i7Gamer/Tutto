import { io } from 'socket.io-client';
import { getLeaders } from '../utils/coreGameEngine';
import { DEFAULT_RECONNECT_TIMEOUT } from '../utils/configValidation';
import i18n from '../i18n';
import { validateOnlineConfig } from './persistence';
import { getSocket, setSocket } from './socketRef';
import type { GameStore, JoinRoomResponse, ConfigKeys, ImmerStateCreator } from './storeTypes';

type SocketSlice = Pick<GameStore,
  | 'connectSocket' | 'joinRoom' | 'leaveRoom' | 'kickPlayer'
  | 'cancelReconnect' | 'pushState' | 'sendOnlineStats'
>;

export const createSocketSlice: ImmerStateCreator<SocketSlice> = (set, get) => ({
  cancelReconnect: (roomId?: string | null, name?: string | null) => {
    localStorage.removeItem('tutto_dice_turn_state');
    sessionStorage.removeItem('tutto_online_session');
    set({ pendingReconnectSession: null, liveTurnState: null, showReconnectPopup: false });

    // Abandoning an active room (the "Return to Main Menu" path) must also drop
    // the room identity and game state from the store — the setMode('local')
    // that follows only overwrites the keys a saved local game happens to
    // contain, so without this the stale roomId later renders a phantom
    // joined-room lobby (or the online roster bleeds into local mode).
    // Guarded on the STORE's roomId: declining the restore prompt on a fresh
    // page load (store roomId never set — the roomId argument here identifies
    // the room to leave server-side) must not wipe a restored local game.
    if (get().roomId) {
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
        hostId: null,
        myName: null,
      });
    }

    if (!roomId) return;

    const tempSocket = io(window.location.origin);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeoutId);
      tempSocket.disconnect();
    };
    const timeoutId = setTimeout(cleanup, 10000);

    tempSocket.on('connect_error', cleanup);
    tempSocket.on('connect', () => {
      const savedColor = localStorage.getItem('tutto_color');
      tempSocket.emit('joinRoom', {
        roomId,
        name,
        deviceId: get().deviceId,
        color: savedColor,
      }, (res: JoinRoomResponse) => {
        if (res?.success) tempSocket.emit('leaveRoom');
        cleanup();
      });
    });
  },

  connectSocket: (url?: string) => {
    if (!getSocket()) {
      const sock = io(url ?? window.location.origin);
      setSocket(sock);

      sock.on('gameState', (serverState: Partial<GameStore>) => {
        const wasFinished = get().finished;
        set((prev) => {
          const wasDisconnected = prev.showReconnectPopup;

          if (prev.mode === 'online' && prev.status === 'lobby' && serverState.status === 'lobby') {
            if (prev.winningScore !== serverState.winningScore) {
              prev.toasts.push({
                id: Date.now() + Math.random(),
                message: i18n.t('game.toastWinningScore', {
                  defaultValue: 'Winning score: {{value}}',
                  value: serverState.winningScore,
                }),
              });
            }
            if (prev.turnDuration !== serverState.turnDuration) {
              const value = serverState.turnDuration === 0
                ? i18n.t('common.disabled', 'Disabled')
                : i18n.t('game.timeSeconds', { defaultValue: '{{time}}s', time: serverState.turnDuration });
              prev.toasts.push({
                id: Date.now() + Math.random(),
                message: i18n.t('game.toastTurnTimer', { defaultValue: 'Turn timer: {{value}}', value }),
              });
            }
            if (prev.reconnectTimeout !== serverState.reconnectTimeout) {
              prev.toasts.push({
                id: Date.now() + Math.random(),
                message: i18n.t('game.toastKickTimer', {
                  defaultValue: 'Kick timer: {{value}}',
                  value: `${serverState.reconnectTimeout}s`,
                }),
              });
            }
            if (JSON.stringify(prev.initialCards) !== JSON.stringify(serverState.initialCards)) {
              prev.toasts.push({ id: Date.now() + Math.random(), message: i18n.t('game.toastDeckChanged', 'Deck composition changed') });
            }
          }
          if (prev.mode === 'online' && prev.status === 'playing' && serverState.status === 'lobby' && !prev.finished && (serverState.players?.length ?? 0) >= 2) {
            prev.toasts.push({ id: Date.now() + Math.random(), message: i18n.t('game.toastHostEndedEarly', 'Host ended game early') });
          }
          Object.assign(prev, serverState);

          const isNewReconnect = wasDisconnected && serverState.status === 'playing';
          if (isNewReconnect) {
            prev.justReconnected = true;
          } else if (prev.justReconnected) {
            // Self-clearing: true for exactly one gameState event's processing
            // window, then reset here on the next one — regardless of whether
            // any component (e.g. Game.tsx) was mounted to react to it and
            // clear it itself. Without this it could get stuck true forever
            // (e.g. reconnecting as a spectator, or on physical dice) and
            // wrongly resurface on a later, unrelated turn.
            prev.justReconnected = false;
          }
          prev.showReconnectPopup = false;
        });
        // Pass the server-computed remaining turn time so the display countdown
        // resyncs to it (see syncOnlineTimers for why it is authoritative).
        get().syncOnlineTimers(serverState.turnTimeRemaining);

        if (!wasFinished && get().finished) {
          get().sendOnlineStats();
        }
      });

      sock.on('playerDisconnected', (name: string) => {
        const seconds = get().reconnectTimeout || DEFAULT_RECONNECT_TIMEOUT;
        get().addToast(i18n.t('game.playerDisconnected', {
          defaultValue: '{{name}} disconnected! They have {{seconds}} seconds to reconnect.',
          name,
          seconds,
        }));
      });

      sock.on('nameConflictWithDisconnected', (name: string) => {
        get().addToast(i18n.t('game.nameConflictWithDisconnected', {
          defaultValue: 'Someone tried to join as "{{name}}", which belongs to a disconnected player. Kick them below to free up the name.',
          name,
        }));
      });

      sock.on('hostId', (hostSocketId: string) => {
        set({ isHost: hostSocketId === sock.id, hostId: hostSocketId });
      });

      sock.on('kicked', () => {
        get().addToast(i18n.t('game.kickedByHost', 'You were kicked by the host'));
        set({ roomId: null, isHost: false, hostId: null, myName: null });
        sessionStorage.removeItem('tutto_online_session');
        get().setMode('local');
      });

      sock.on('gameAborted', () => {
        get().addToast(i18n.t('game.aborted'));
      });

      sock.on('disconnect', () => {
        if (get().mode === 'online') set({ showReconnectPopup: true });
      });

      sock.on('connect', () => {
        const { roomId, myName, deviceId } = get();
        if (roomId && myName) {
          const savedColor = localStorage.getItem('tutto_color');
          sock.emit('joinRoom', { roomId, name: myName, deviceId, color: savedColor }, (res: JoinRoomResponse) => {
            if (res.success) {
              set({ isHost: res.isHost ?? false });
              return;
            }
            // The seat is unrecoverable (room deleted after the reconnect
            // timeout, name reclaimed, …) — retrying on the next 'connect'
            // can never succeed, so stop showing the "attempting to
            // reconnect" popup and drop back to the online join form.
            get().addToast(res.error || i18n.t('home.restore.failed', 'Failed to reconnect to the game'));
            get().leaveRoom();
            set({ showReconnectPopup: false, hostId: null });
          });
        }
      });
    }
  },

  joinRoom: (room, name, isReconnect = false) => {
    if (!isReconnect) {
      localStorage.removeItem('tutto_dice_turn_state');
      set({ liveTurnState: null });
    }
    return new Promise<JoinRoomResponse>((resolve) => {
      let initialConfig: Partial<Pick<GameStore, ConfigKeys>> | undefined = undefined;
      try {
        const storedConfigStr = localStorage.getItem('tutto_online_config');
        if (storedConfigStr) {
          // Only transmit fields the server would accept — same validator the
          // lobby uses when loading this config, so both stay in sync.
          const validated = validateOnlineConfig(JSON.parse(storedConfigStr));
          if (Object.keys(validated).length > 0) initialConfig = validated;
        }
      } catch (e) {
        console.error('Failed to parse online config for joinRoom', e);
      }

      get().connectSocket();
      const savedColor = localStorage.getItem('tutto_color');
      const socket = getSocket();
      if (!socket) {
        resolve({ success: false, error: 'Socket not connected' });
        return;
      }
      socket.emit('joinRoom', { roomId: room, name, deviceId: get().deviceId, color: savedColor, initialConfig }, (res: JoinRoomResponse) => {
        if (res.success) {
          set({ roomId: room, isHost: res.isHost ?? false, myName: name, mode: 'online', isOnline: true });
          sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: room, myName: name }));

          if (res.isHost && !isReconnect && initialConfig) {
            get().addToast(i18n.t('lobby.savedSettingsLoaded'));
          }
        }
        resolve(res);
      });
    });
  },

  leaveRoom: () => {
    const socket = getSocket();
    if (socket) socket.emit('leaveRoom');
    get().stopOnlineTimers();
    sessionStorage.removeItem('tutto_online_session');
    localStorage.removeItem('tutto_dice_turn_state');
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
      liveTurnState: null,
    });
  },

  kickPlayer: (targetSocketId) => {
    const socket = getSocket();
    if (get().isHost && socket) socket.emit('kickPlayer', targetSocketId);
  },

  pushState: () => {
    const s = get();
    const socket = getSocket();
    if (s.isOnline && socket) {
      const {
        players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
        randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
        previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore,
        chartValues, chartNames, chartLabels, status, liveTurnState,
      } = s;
      socket.emit('pushState', {
        roomId: s.roomId,
        newState: {
          players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
          randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
          previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore,
          chartValues, chartNames, chartLabels, status, liveTurnState,
        },
      });
    }
  },

  sendOnlineStats: () => {
    const s = get();
    const socket = getSocket();
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
          kleeblattCompleted: me.timesKleeblattCompleted || 0, x2Received: me.timesx2Received || 0,
          totalTurns: me.totalTurns || 0, busts: me.busts || 0,
          feuerwerkBusts: me.feuerwerkBusts || 0, x2Busts: me.x2Busts || 0,
          feuerwerkPointsScored: me.feuerwerkPointsScored || 0, x2PointsScored: me.x2PointsScored || 0,
          highestTurnScore: me.highestTurnScore || 0, totalScore: me.score || 0,
          fastestWinTurns: didIWin ? (me.totalTurns || 0) : null,
          fastestLossTurns: !didIWin ? (me.totalTurns || 0) : null,
        },
      });
    }

    // Global stats are submitted by the host via socket so no secret token
    // needs to be compiled into the client bundle. The server validates the
    // sender is the room host by socket identity.
    if (s.isHost && socket) {
      socket.emit('submitGlobalStats', {
        roomId: s.roomId,
        payload: get().buildGlobalStatsPayload(),
      });
    }
  },
});
