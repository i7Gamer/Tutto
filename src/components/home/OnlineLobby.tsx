import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Copy, Check } from 'lucide-react';
import {
  DiceModeSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton, PlayerList,
  AudioSettingSelector, HapticsSettingSelector, EnforceDiceModeToggle, DiceModeEnforcedBadge,
} from './LobbyShared';
import { hasPlayableDeck } from '../../utils/coreGameEngine';
import type { GameStore } from '../../store/useGameStore';

// How long the copy button shows its "copied" checkmark before reverting.
const COPY_FEEDBACK_MS = 1500;

interface JoinRoomResult {
  error?: string;
}

interface OnlineLobbyProps {
  game: GameStore;
}

export default function OnlineLobby({ game }: OnlineLobbyProps) {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  interface RecentRoom {
    roomId: string;
    name: string;
    timestamp: number;
  }

  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => {
    try {
      const raw = localStorage.getItem('tutto_recent_rooms');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const getStoredValue = (key: string): string => {
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
  };

  const [inputRoomCode, setInputRoomCode] = useState(() => getStoredValue('tutto_last_room'));
  const [inputName, setInputName] = useState(() => getStoredValue('tutto_last_name'));
  const [errorMsg, setErrorMsg] = useState('');
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);

  const { players, startGame, reorderPlayers, changeMyColor, isHost, hostId, joinRoom, leaveRoom, roomId, myName, kickPlayer, addToast } = game;

  const handleCopyRoomCode = async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      setRoomCodeCopied(true);
      addToast(t('lobby.online.roomCodeCopied', 'Room code copied!'));
      setTimeout(() => setRoomCodeCopied(false), COPY_FEEDBACK_MS);
    } catch {
      addToast(t('lobby.online.roomCodeCopyFailed', 'Could not copy room code'));
    }
  };

  const handleJoin = async () => {
    if (!inputRoomCode || !inputName) {
      setErrorMsg(t('lobby.online.enterBoth', 'Please enter both a Room Code and a Name.'));
      return;
    }
    setErrorMsg('');
    const res = await joinRoom(inputRoomCode, inputName) as JoinRoomResult | undefined;
    if (res && res.error) {
      setErrorMsg(res.error);
    } else {
      localStorage.setItem('tutto_last_room', inputRoomCode);
      localStorage.setItem('tutto_last_name', inputName);
      
      try {
        const raw = localStorage.getItem('tutto_recent_rooms');
        let list: RecentRoom[] = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        list = list.filter(item => item.roomId !== inputRoomCode);
        list.unshift({ roomId: inputRoomCode, name: inputName, timestamp: Date.now() });
        list = list.slice(0, 5);
        localStorage.setItem('tutto_recent_rooms', JSON.stringify(list));
        setRecentRooms(list);
      } catch (e) {
        console.error('Failed to update recent rooms', e);
      }
    }
  };

  const handleSelectRecentRoom = (room: RecentRoom) => {
    setInputRoomCode(room.roomId);
    setInputName(room.name);
  };

  if (!roomId) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 max-w-sm mx-auto">
        <h3 className="text-xl font-bold mb-4 text-center">{t('lobby.online.joinOrCreateRoom', 'Join or Create Room')}</h3>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('lobby.online.roomCode', 'Room Code')}</label>
            <input
              type="text"
              value={inputRoomCode}
              onChange={(e) => setInputRoomCode(e.target.value)}
              placeholder={t('lobby.online.roomCodePlaceholder', 'e.g. 1234')}
              className="bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('lobby.online.yourName', 'Your Name')}</label>
            <input
              type="text"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              placeholder={t('lobby.online.yourNamePlaceholder', 'e.g. Alice')}
              className="bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {errorMsg && <div className="text-red-500 text-sm font-medium bg-red-50 p-2 rounded">{errorMsg}</div>}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl mt-2 shadow-lg shadow-indigo-500/30 transition-all"
            onClick={() => void handleJoin()}
          >
            {t('lobby.online.joinCreateButton', 'Join / Create')}
          </motion.button>

          {recentRooms.length > 0 && (
            <div className="flex flex-col gap-2 mt-4 border-t border-gray-150 dark:border-slate-700 pt-4">
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('lobby.online.recentRooms', 'Recent Rooms')}</label>
              <div className="flex flex-col gap-1">
                {recentRooms.map((room) => (
                  <button
                    key={room.roomId}
                    onClick={() => handleSelectRecentRoom(room)}
                    className="flex justify-between items-center bg-gray-50 hover:bg-indigo-50/50 dark:bg-slate-800/30 dark:hover:bg-slate-700/40 border border-gray-200/80 dark:border-slate-700 rounded-lg px-3 py-2 text-sm transition-colors text-left font-medium text-gray-700 dark:text-gray-200 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                  >
                    <span>{room.roomId} <span className="text-gray-400 dark:text-gray-500 text-xs font-normal">({room.name})</span></span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 font-normal">{new Date(room.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            {/* mb-0 overrides the global `h3 { margin-bottom: 1rem }` base rule
                (index.css) — left in place, that stray bottom margin is what
                pushed this heading's centered content above the copy/leave
                buttons it shares this items-center row with. */}
            <h3 className="text-2xl font-bold text-indigo-900 dark:text-indigo-200 mb-0">{t('lobby.online.room', 'Room: {{roomId}}', { roomId })}</h3>
            <button
              className="text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 p-2 rounded-lg transition-colors"
              onClick={() => void handleCopyRoomCode()}
              title={t('lobby.online.copyRoomCode', 'Copy room code')}
              aria-label={t('lobby.online.copyRoomCode', 'Copy room code')}
            >
              {roomCodeCopied ? <Check size={20} className="text-emerald-500" /> : <Copy size={20} />}
            </button>
          </div>
          <button
            className="text-red-500 hover:bg-red-50 border border-red-200 px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => {
              if (window.confirm(t('lobby.online.leaveConfirm', 'Do you really want to leave the room?'))) leaveRoom();
            }}
          >
            {t('lobby.online.leaveRoom', 'Leave Room')}
          </button>
        </div>
        <p className="mb-6 text-gray-700 dark:text-gray-200 text-lg">
          {t('lobby.online.youAre', 'You are:')} <strong className="text-indigo-600 dark:text-indigo-400">{myName}</strong>{' '}
          {isHost ? <span className="text-amber-500 font-medium">({t('lobby.online.hostBadge', 'Host')})</span> : ''}
        </p>

        <h4 className="font-bold text-gray-800 dark:text-gray-100 mb-3">{t('lobby.online.playersInLobby', 'Players in Lobby:')}</h4>
        <PlayerList
          players={players}
          reorderPlayers={reorderPlayers}
          isOnline={true}
          myName={myName}
          hostId={hostId}
          isHost={isHost}
          changeColor={(_p, color) => changeMyColor(color)}
          onRemovePlayer={(p) => { if (p.socketId) kickPlayer(p.socketId); }}
        />

        <div className="flex flex-row flex-wrap justify-center items-stretch gap-2 sm:gap-4 mb-8">
          {/* diceMode is deliberately per-device, not room config by default: it
              decides how THIS player enters their own turns (digital dice vs
              typing a physical-dice score). Spectators see the active player's
              live digital dice regardless (see GameControls). The host may
              override this per-device default by enforcing a single mode for
              everyone (EnforceDiceModeToggle below) — a non-host's own selector
              is hidden while that's active since it would no longer do anything. */}
          {(isHost || !game.enforcedDiceMode) && (
            <DiceModeSelector diceMode={game.diceMode} setDiceMode={game.setDiceMode} nameSuffix="Online" />
          )}
          {!isHost && game.enforcedDiceMode && (
            <DiceModeEnforcedBadge enforcedDiceMode={game.enforcedDiceMode} />
          )}
          <AudioSettingSelector audioEnabled={game.audioEnabled} setAudioEnabled={game.setAudioEnabled} nameSuffix="Online" />
          <HapticsSettingSelector hapticsEnabled={game.hapticsEnabled} setHapticsEnabled={game.setHapticsEnabled} nameSuffix="Online" />
          {isHost && (
            <EnforceDiceModeToggle
              diceMode={game.diceMode}
              enforcedDiceMode={game.enforcedDiceMode}
              setEnforcedDiceMode={game.setEnforcedDiceMode}
            />
          )}
          <AdvancedOptionsToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
        </div>

        <AdvancedOptionsPanel
          showAdvanced={showAdvanced}
          game={game}
          isOnline={true}
          readOnly={!isHost}
          onResetGeneralSettings={isHost ? () => game.resetGeneralSettings() : null}
          onResetCards={isHost ? () => game.resetInitialCards() : null}
        />
      </div>

      <AnimatePresence>
        {isHost ? (
          <StartGameButton
            startGame={startGame}
            playersCount={players ? players.length : 0}
            disabled={players.length < 2 || players?.some(p => p.disconnected) || !hasPlayableDeck(game.initialCards)}
            disabledMessage={!hasPlayableDeck(game.initialCards) ? t('lobby.emptyDeck', 'Add at least one card to the deck') : undefined}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center text-indigo-600 font-bold text-lg p-6 bg-white dark:bg-slate-800/40 rounded-xl border border-indigo-100"
          >
            <div className="flex justify-center mb-3">
              <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
            </div>
            {t('lobby.online.waitingForHost', 'Waiting for host to start the game...')}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
