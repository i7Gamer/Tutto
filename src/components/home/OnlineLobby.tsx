import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Copy, Check, X, Share2, QrCode, ScanLine } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  DiceModeSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton, PlayerList, CustomGameBadge,
  AudioSettingSelector, HapticsSettingSelector, EnforceDiceModeToggle, DiceModeEnforcedBadge,
  RulesetSelector, RulesetBadge,
} from './LobbyShared';
import { hasPlayableDeck } from '../../utils/coreGameEngine';
import { MIN_ONLINE_PLAYERS, MAX_PLAYER_NAME_LENGTH, MAX_ROOM_ID_LENGTH } from '../../utils/configValidation';
import { JOIN_TIMEOUT_MS } from '../../utils/uiTimings';
import { parseRecentRooms, MAX_RECENT_ROOMS, type RecentRoom } from '../../utils/recentRooms';
import { buildRoomLink } from '../../utils/roomLink';
import { supportsNativeShare } from '../../utils/shareSupport';
import { localStore } from '../../utils/storage';
import { useGameStore } from '../../store/useGameStore';
import ConfirmModal from '../ConfirmModal';
import RoomQrCode from './RoomQrCode';
import RoomQrScanner from './RoomQrScanner';
import { joinErrorMessage } from '../../utils/joinErrors';

// How long the copy button shows its "copied" checkmark before reverting.
const COPY_FEEDBACK_MS = 1500;

// JOIN_TIMEOUT_MS (utils/uiTimings.ts) bounds how long the join button stays
// locked on an ack that may never arrive.

interface JoinRoomResult {
  error?: string;
  // Which refusal `error` is describing, for translating it. Absent on a
  // success, on the watchdog's own timeout result, and from any server older
  // than the codes.
  code?: string;
  // The name the server actually seated us under. A mid-game rejoin is refused
  // a rename — the seat keeps its original name (see JoinRoomResponse) and the
  // store adopts it as myName — so remembering what was TYPED left this lobby
  // prefilling, and listing under Recent Rooms, a name the room will not seat.
  name?: string;
}

interface OnlineLobbyProps {
  /**
   * The room a shared join link asked for (see useRoomLink). Wins over the
   * remembered last room: an explicit invitation beats a stale default.
   */
  initialRoomCode?: string;
}

export default function OnlineLobby({ initialRoomCode }: OnlineLobbyProps) {
  const { t, i18n } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // localStore already absorbs a throwing read (blocked site data, a
  // third-party context, dom.storage.enabled=false — this screen is where
  // those failure modes were first accounted for); this only adds the
  // empty-string default the form fields want.
  const getStoredValue = (key: string): string => localStore.read(key) ?? '';

  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(
    () => parseRecentRooms(getStoredValue('tutto_recent_rooms')),
  );

  const [inputRoomCode, setInputRoomCode] = useState(() => initialRoomCode ?? getStoredValue('tutto_last_room'));
  const [inputName, setInputName] = useState(() => getStoredValue('tutto_last_name'));
  // Arriving from a link, the code is already filled in and the name is the
  // only thing still missing — so that is where the cursor belongs.
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initialRoomCode) nameInputRef.current?.focus();
  }, [initialRoomCode]);
  const [errorMsg, setErrorMsg] = useState('');
  const [roomLinkCopied, setRoomLinkCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  // Read once: the sheet either exists on this device or it does not, and a
  // button that appears mid-session would be odd.
  const [canShare] = useState(supportsNativeShare);
  const [isJoining, setIsJoining] = useState(false);
  // Re-entrancy guard for handleJoin. A ref, not the state above: two clicks
  // in the same frame both read the pre-render `isJoining === false` from
  // their shared closure (and `disabled` hasn't been committed yet either),
  // so only a synchronously-written ref actually blocks the second call.
  const joiningRef = useRef(false);
  // One join attempt reports its outcome twice (the raced result and the late
  // ack behind it), and only the first success may be recorded.
  const joinRecordedRef = useRef(false);

  // Selects only what this lobby renders — the whole store used to arrive as
  // a prop from Home, re-rendering the entire lobby tree on any store change.
  const {
    players, startGame, reorderPlayers, changeMyColor, isHost, hostId, joinRoom,
    leaveRoom, roomId, myName, kickPlayer, addToast,
    diceMode, setDiceMode, enforcedDiceMode, setEnforcedDiceMode,
    audioEnabled, setAudioEnabled, hapticsEnabled, setHapticsEnabled,
    initialCards, resetGeneralSettings, resetInitialCards,
    ruleset, setRuleset,
  } = useGameStore(useShallow((s) => ({
    players: s.players,
    startGame: s.startGame,
    reorderPlayers: s.reorderPlayers,
    changeMyColor: s.changeMyColor,
    isHost: s.isHost,
    hostId: s.hostId,
    joinRoom: s.joinRoom,
    leaveRoom: s.leaveRoom,
    roomId: s.roomId,
    myName: s.myName,
    kickPlayer: s.kickPlayer,
    addToast: s.addToast,
    diceMode: s.diceMode,
    setDiceMode: s.setDiceMode,
    enforcedDiceMode: s.enforcedDiceMode,
    setEnforcedDiceMode: s.setEnforcedDiceMode,
    audioEnabled: s.audioEnabled,
    setAudioEnabled: s.setAudioEnabled,
    hapticsEnabled: s.hapticsEnabled,
    setHapticsEnabled: s.setHapticsEnabled,
    initialCards: s.initialCards,
    resetGeneralSettings: s.resetGeneralSettings,
    resetInitialCards: s.resetInitialCards,
    ruleset: s.ruleset,
    setRuleset: s.setRuleset,
  })));

  // Neither panel is meant to outlive the room it was opened for. The scanner
  // is the pointed one: open it, join by typing instead, play, leave — and the
  // camera comes back on with nobody having asked. The QR code is the same flag
  // lifetime one room later, handing out an invite unprompted. Both reset on
  // the room changing, the render-time pattern GameControls uses for its card
  // flip.
  const [panelsRoomId, setPanelsRoomId] = useState(roomId);
  if (roomId !== panelsRoomId) {
    setPanelsRoomId(roomId);
    setShowScanner(false);
    setShowQr(false);
  }

  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyFeedbackTimer.current), []);

  // A link rather than the bare code: the code has to be retyped by whoever
  // receives it, while the link opens the lobby with it already filled in.
  const roomLink = roomId ? buildRoomLink(roomId, window.location.href) : '';

  const handleCopyRoomLink = async () => {
    if (!roomLink) return;
    try {
      await navigator.clipboard.writeText(roomLink);
      setRoomLinkCopied(true);
      addToast(t('lobby.online.roomLinkCopied', 'Invite link copied!'));
      clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = setTimeout(() => setRoomLinkCopied(false), COPY_FEEDBACK_MS);
    } catch {
      addToast(t('lobby.online.roomLinkCopyFailed', 'Could not copy the invite link'));
    }
  };

  const handleShareRoomLink = async () => {
    if (!roomLink) return;
    try {
      await navigator.share({ title: t('app.title', 'Tutto'), url: roomLink });
    } catch (e) {
      // Dismissing the sheet rejects with AbortError. That is the player
      // backing out, not a failure worth a toast.
      if ((e as Error)?.name === 'AbortError') return;
      addToast(t('lobby.online.roomLinkShareFailed', 'Could not share the invite link'));
    }
  };

  const persistRecentRooms = (list: RecentRoom[]) => {
    // State only follows a write that actually landed: the list on screen
    // keeps describing what is stored rather than a change that did not
    // survive — localStore.write's return value is exactly that answer.
    if (localStore.write('tutto_recent_rooms', JSON.stringify(list))) {
      setRecentRooms(list);
    } else {
      console.error('Failed to update recent rooms');
    }
  };

  const handleJoin = () => {
    const trimmedRoomCode = inputRoomCode.trim();
    const trimmedName = inputName.trim();
    if (!trimmedRoomCode || !trimmedName) {
      setErrorMsg(t('lobby.online.enterBoth', 'Please enter both a Room Code and a Name.'));
      return;
    }
    return attemptJoin(trimmedRoomCode, trimmedName);
  };

  // Enter from either field does what the button does — the expected gesture
  // in a two-field form, and on a phone it is the keyboard's own Go key.
  // No separate guard needed: it routes through handleJoin, so the empty-field
  // message and the re-entrancy ref both apply exactly as they do to a click.
  const handleJoinKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    void handleJoin();
  };

  // Takes both values as arguments rather than reading the inputs: a scan joins
  // with a room code the state it just set has not committed yet.
  const attemptJoin = async (trimmedRoomCode: string, trimmedName: string) => {
    // A double-click before the ack returns would fire a second joinRoom emit
    // for the same device (a duplicate seat, or a spurious "name taken"). Same
    // for a frame the camera decodes while a typed join is still pending.
    if (joiningRef.current) return;
    setErrorMsg('');
    joiningRef.current = true;
    joinRecordedRef.current = false;
    setIsJoining(true);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const joining = joinRoom(trimmedRoomCode, trimmedName) as Promise<JoinRoomResult | undefined>;
      // The watchdog only decides how long the FORM waits. A slow ack that
      // eventually succeeds still seated this client, so the room has to be
      // remembered either way — losing that race used to mean the room the
      // player is now sitting in never reached Recent Rooms at all.
      // handleJoinResult is idempotent (see the joinRecordedRef guard).
      void joining.then((late) => handleJoinResult(late, trimmedRoomCode, trimmedName, Date.now()), () => {});
      const res = await Promise.race([
        joining,
        new Promise<JoinRoomResult>((resolve) => {
          watchdog = setTimeout(
            () => resolve({ error: t('lobby.online.joinTimeout', 'No response from the server. Please try again.') }),
            JOIN_TIMEOUT_MS,
          );
        }),
      ]);
      handleJoinResult(res, trimmedRoomCode, trimmedName, Date.now());
    } finally {
      clearTimeout(watchdog);
      joiningRef.current = false;
      setIsJoining(false);
    }
  };

  // joinedAt is passed in rather than read here: this runs on the join ack, and
  // the clock read belongs with the action that caused it.
  const handleJoinResult = (
    res: JoinRoomResult | undefined,
    trimmedRoomCode: string,
    trimmedName: string,
    joinedAt: number,
  ) => {
    if (res && res.error) {
      // Falls back to the server's own sentence when the code is unknown here,
      // so an older or newer server still fills the error box (see joinErrors).
      setErrorMsg(joinErrorMessage(res, (key, defaultValue) => t(key, defaultValue)) ?? res.error);
    } else {
      // Called from two places for the same attempt (the raced result and the
      // late ack behind it), so the room is recorded exactly once — otherwise
      // a slow-but-successful join would rewrite Recent Rooms twice with two
      // different timestamps.
      if (joinRecordedRef.current) return;
      joinRecordedRef.current = true;
      // A late success supersedes the watchdog's message: the player IS in the
      // room, so leaving "no response from the server" on screen is a lie.
      setErrorMsg('');
      // The seat's name, not the typed one — see JoinRoomResult. An ack that
      // names no seat (an older server, or the watchdog resolving first) leaves
      // what was typed, which is what the store adopted too.
      const seatedName = res?.name ?? trimmedName;
      // The join has already SUCCEEDED, so a refused write here is
      // bookkeeping loss, not a join failure — localStore absorbs the throw
      // that used to escape the caller's void'ed promise as an unhandled
      // rejection. Remembering the room is best-effort.
      localStore.write('tutto_last_room', trimmedRoomCode);
      localStore.write('tutto_last_name', seatedName);

      // Same validated read as the initial state above, so the write path
      // can no longer carry a malformed entry forward either.
      const remembered = parseRecentRooms(getStoredValue('tutto_recent_rooms'))
        .filter(item => item.roomId !== trimmedRoomCode);
      const joined: RecentRoom = { roomId: trimmedRoomCode, name: seatedName, timestamp: joinedAt };
      persistRecentRooms([joined, ...remembered].slice(0, MAX_RECENT_ROOMS));
    }
  };

  const handleSelectRecentRoom = (room: RecentRoom) => {
    setInputRoomCode(room.roomId);
    setInputName(room.name);
  };

  // The only way to drop a remembered room. Neither Home's "Clear Cache &
  // Reload" nor the ErrorBoundary's recovery path clears this key, so without
  // this a room joined once stayed on the list for the life of the browser
  // profile. No confirmation: rejoining the room puts it straight back.
  const handleForgetRecentRoom = (roomId: string) => {
    persistRecentRooms(recentRooms.filter(room => room.roomId !== roomId));
  };

  // Unlike a followed link — which arrives because someone sent a URL, and may
  // not have been asked for at all — pointing a camera at a code is a
  // deliberate act aimed at one specific room. So with a name already on the
  // form there is nothing left to ask, and the Join tap is a formality: go
  // straight in. Without one, fall back to filling the code in and waiting.
  const handleRoomScanned = (scannedRoomId: string) => {
    setInputRoomCode(scannedRoomId);
    setShowScanner(false);
    const trimmedName = inputName.trim();
    if (trimmedName) {
      void attemptJoin(scannedRoomId, trimmedName);
      return;
    }
    nameInputRef.current?.focus();
  };

  if (!roomId) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 max-w-sm mx-auto">
        <h3 className="text-xl font-bold mb-4 text-center">{t('lobby.online.joinOrCreateRoom', 'Join or Create Room')}</h3>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('lobby.online.roomCode', 'Room Code')}</label>
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={inputRoomCode}
                onChange={(e) => setInputRoomCode(e.target.value)}
                onKeyDown={handleJoinKeyDown}
                maxLength={MAX_ROOM_ID_LENGTH}
                placeholder={t('lobby.online.roomCodePlaceholder', 'e.g. 1234')}
                className="flex-1 min-w-0 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              />
              {/* Always offered, never pre-emptively hidden: whether the camera
                  can be used depends on the origin and the permission, and the
                  panel explains which one is in the way. A button that silently
                  is not there teaches nobody anything. */}
              <button
                onClick={() => setShowScanner(current => !current)}
                aria-expanded={showScanner}
                title={t('lobby.online.scanQr', 'Scan a QR code')}
                aria-label={t('lobby.online.scanQr', 'Scan a QR code')}
                className="shrink-0 px-3 rounded-lg border border-gray-200 dark:border-slate-600 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
              >
                <ScanLine size={18} />
              </button>
            </div>
            {showScanner && (
              <RoomQrScanner onRoomScanned={handleRoomScanned} onClose={() => setShowScanner(false)} />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('lobby.online.yourName', 'Your Name')}</label>
            <input
              ref={nameInputRef}
              type="text"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              onKeyDown={handleJoinKeyDown}
              maxLength={MAX_PLAYER_NAME_LENGTH}
              placeholder={t('lobby.online.yourNamePlaceholder', 'e.g. Alice')}
              className="bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {/* assertive, not polite: this is the direct answer to a button the
              user pressed a moment ago, and it appears well away from where
              focus is — without it the form simply went quiet on a failure.
              role and aria-live both, because Safari/VoiceOver has historically
              honoured one without the other. */}
          {errorMsg && (
            <div
              role="alert"
              aria-live="assertive"
              className="text-red-500 dark:text-red-300 text-sm font-medium bg-red-50 dark:bg-red-900/30 p-2 rounded-sm"
            >
              {errorMsg}
            </div>
          )}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl mt-2 shadow-lg shadow-indigo-500/30 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={isJoining}
            onClick={() => void handleJoin()}
          >
            {isJoining
              ? t('lobby.online.joining', 'Joining…')
              : t('lobby.online.joinCreateButton', 'Join / Create')}
          </motion.button>

          {recentRooms.length > 0 && (
            <div className="flex flex-col gap-2 mt-4 border-t border-gray-200 dark:border-slate-700 pt-4">
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('lobby.online.recentRooms', 'Recent Rooms')}</label>
              <div className="flex flex-col gap-1">
                {/* The row is two sibling buttons, not one with the remove
                    control nested inside it: a button inside a button is
                    invalid, and the click would select the room it removes. */}
                {recentRooms.map((room) => (
                  <div key={room.roomId} className="flex items-stretch gap-1">
                    <button
                      onClick={() => handleSelectRecentRoom(room)}
                      className="flex-1 min-w-0 flex justify-between items-center gap-2 bg-gray-50 hover:bg-indigo-50/50 dark:bg-slate-800/30 dark:hover:bg-slate-700/40 border border-gray-200/80 dark:border-slate-700 rounded-lg px-3 py-2 text-sm transition-colors text-left font-medium text-gray-700 dark:text-gray-200 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                    >
                      <span className="truncate">{room.roomId} <span className="text-gray-400 dark:text-gray-500 text-xs font-normal">({room.name})</span></span>
                      {/* Dated in the UI language, not the device's: a German
                          UI on an English-locale machine used to date its own
                          room list "Aug 17". */}
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500 font-normal">{new Date(room.timestamp).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}</span>
                    </button>
                    <button
                      onClick={() => handleForgetRecentRoom(room.roomId)}
                      aria-label={t('lobby.online.forgetRoom', 'Remove from list') + ` ${room.roomId}`}
                      title={t('lobby.online.forgetRoom', 'Remove from list')}
                      className="shrink-0 px-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 border border-transparent hover:border-red-200 dark:hover:border-red-900 transition-colors cursor-pointer"
                    >
                      <X size={14} />
                    </button>
                  </div>
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
        {/* flex-wrap and the min-w-0/truncate/shrink-0 below: this row holds a
            heading of unbounded length plus up to four buttons, and on a narrow
            phone the fixed-width ones would otherwise push the whole row past
            the container rather than the heading giving way. */}
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
          <div className="flex items-center gap-1 min-w-0">
            {/* mb-0 overrides the global `h3 { margin-bottom: 1rem }` base rule
                (index.css) — left in place, that stray bottom margin is what
                pushed this heading's centered content above the copy/leave
                buttons it shares this items-center row with. */}
            <h3 className="text-2xl font-bold text-indigo-900 dark:text-indigo-200 mb-0 truncate min-w-0">{t('lobby.online.room', 'Room: {{roomId}}', { roomId })}</h3>
            <button
              className="shrink-0 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 p-2 rounded-lg transition-colors"
              onClick={() => void handleCopyRoomLink()}
              title={t('lobby.online.copyRoomLink', 'Copy invite link')}
              aria-label={t('lobby.online.copyRoomLink', 'Copy invite link')}
            >
              {roomLinkCopied ? <Check size={20} className="text-emerald-500" /> : <Copy size={20} />}
            </button>
            {canShare && (
              <button
                className="shrink-0 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 p-2 rounded-lg transition-colors"
                onClick={() => void handleShareRoomLink()}
                title={t('lobby.online.shareRoomLink', 'Share invite link')}
                aria-label={t('lobby.online.shareRoomLink', 'Share invite link')}
              >
                <Share2 size={20} />
              </button>
            )}
            {/* Collapsed by default: it is only wanted when someone is
                physically present to scan it, and expanded it would push the
                player list off a phone screen. */}
            <button
              className="shrink-0 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 p-2 rounded-lg transition-colors"
              onClick={() => setShowQr(current => !current)}
              aria-expanded={showQr}
              title={showQr
                ? t('lobby.online.hideQr', 'Hide QR code')
                : t('lobby.online.showQr', 'Show QR code')}
              aria-label={showQr
                ? t('lobby.online.hideQr', 'Hide QR code')
                : t('lobby.online.showQr', 'Show QR code')}
            >
              <QrCode size={20} />
            </button>
          </div>
          <button
            className="shrink-0 text-red-500 hover:bg-red-50 border border-red-200 px-2 sm:px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => setShowLeaveConfirm(true)}
            title={t('lobby.online.leaveRoom', 'Leave Room')}
            aria-label={t('lobby.online.leaveRoom', 'Leave Room')}
          >
            {/* Icon-only on phones — the label costs header width the room
                code (which truncates) and the three icon buttons need more. */}
            <X size={20} className="sm:hidden" />
            <span className="hidden sm:inline">{t('lobby.online.leaveRoom', 'Leave Room')}</span>
          </button>
        </div>

        {showQr && <RoomQrCode link={roomLink} />}
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

        {isHost
          ? <RulesetSelector ruleset={ruleset} setRuleset={setRuleset} nameSuffix="Online" />
          : <RulesetBadge ruleset={ruleset} />}

        <div className="flex flex-row flex-wrap justify-center items-stretch gap-2 sm:gap-4 mb-8">
          {/* diceMode is deliberately per-device, not room config by default: it
              decides how THIS player enters their own turns (digital dice vs
              typing a physical-dice score). Spectators see the active player's
              live digital dice regardless (see GameControls). The host may
              override this per-device default by enforcing a single mode for
              everyone (EnforceDiceModeToggle below) — a non-host's own selector
              is hidden while that's active since it would no longer do anything. */}
          {(isHost || !enforcedDiceMode) && (
            <DiceModeSelector diceMode={diceMode} setDiceMode={setDiceMode} nameSuffix="Online" />
          )}
          {!isHost && enforcedDiceMode && (
            <DiceModeEnforcedBadge enforcedDiceMode={enforcedDiceMode} />
          )}
          <AudioSettingSelector audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} nameSuffix="Online" />
          <HapticsSettingSelector hapticsEnabled={hapticsEnabled} setHapticsEnabled={setHapticsEnabled} nameSuffix="Online" />
          {isHost && (
            <EnforceDiceModeToggle
              diceMode={diceMode}
              enforcedDiceMode={enforcedDiceMode}
              setEnforcedDiceMode={setEnforcedDiceMode}
            />
          )}
          <AdvancedOptionsToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
        </div>

        <CustomGameBadge />

        <AdvancedOptionsPanel
          showAdvanced={showAdvanced}
          isOnline={true}
          readOnly={!isHost}
          onResetGeneralSettings={isHost ? () => resetGeneralSettings() : null}
          onResetCards={isHost ? () => resetInitialCards() : null}
        />
      </div>

      <AnimatePresence>
        {isHost ? (
          <StartGameButton
            startGame={startGame}
            playersCount={players ? players.length : 0}
            disabled={players.length < MIN_ONLINE_PLAYERS || players?.some(p => p.disconnected) || !hasPlayableDeck(initialCards)}
            disabledMessage={!hasPlayableDeck(initialCards) ? t('lobby.emptyDeck', 'Add at least one card to the deck') : undefined}
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

      <ConfirmModal
        open={showLeaveConfirm}
        danger
        message={t('lobby.online.leaveConfirm', 'Do you really want to leave the room?')}
        onCancel={() => setShowLeaveConfirm(false)}
        onConfirm={() => {
          setShowLeaveConfirm(false);
          leaveRoom();
        }}
      />
    </motion.div>
  );
}
