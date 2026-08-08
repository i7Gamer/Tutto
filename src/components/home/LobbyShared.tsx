import { useState, useEffect, useRef } from 'react';
import type { InputHTMLAttributes, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Play, ChevronUp, ChevronDown, Trash2, UserMinus, Crown, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MIN_WINNING_SCORE, MAX_WINNING_SCORE, MAX_TURN_DURATION, MAX_RECONNECT_TIMEOUT,
  MIN_ENABLED_TURN_DURATION, MIN_ENABLED_RECONNECT_TIMEOUT, MAX_CARD_COUNT,
  snapDisableableDuration,
} from '../../utils/configValidation';
import type { Player, CardType, DiceMode } from '../../types';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '../../store/useGameStore';
import { supportsIOSSwitchHaptic } from '../../utils/iosSwitchHaptic';
import { REORDER_PRESS_RELEASE_MS } from '../../utils/uiTimings';

interface PlayerListProps {
  players: Player[];
  reorderPlayers: (players: Player[]) => void;
  isOnline?: boolean;
  myName?: string | null;
  hostId?: string | null;
  isHost?: boolean;
  changeColor: (p: Player, color: string) => void;
  onRemovePlayer: (p: Player) => void;
}

export function PlayerList({
  players,
  reorderPlayers,
  isOnline = false,
  myName = null,
  hostId = null,
  isHost = true,
  changeColor,
  onRemovePlayer,
}: PlayerListProps) {
  const { t } = useTranslation();

  // The reorder is deferred (together with the blur() in the onClick
  // handlers) — see REORDER_PRESS_RELEASE_MS for why. Only one deferred
  // reorder is ever pending: two presses inside the window would both have
  // been computed from the same pre-swap roster, so applying both would just
  // replay the earlier, stale one — last press wins instead.
  const pendingReorderTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingReorderTimer.current), []);

  const deferReorder = (newPlayers: Player[]) => {
    if (!reorderPlayers) return;
    clearTimeout(pendingReorderTimer.current);
    pendingReorderTimer.current = setTimeout(() => reorderPlayers(newPlayers), REORDER_PRESS_RELEASE_MS);
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newPlayers = [...players];
    [newPlayers[index - 1], newPlayers[index]] = [newPlayers[index], newPlayers[index - 1]];
    deferReorder(newPlayers);
  };

  const handleMoveDown = (index: number) => {
    if (index === players.length - 1) return;
    const newPlayers = [...players];
    [newPlayers[index + 1], newPlayers[index]] = [newPlayers[index], newPlayers[index + 1]];
    deferReorder(newPlayers);
  };

  if (!players || players.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="bg-white dark:bg-slate-800/40 rounded-xl overflow-hidden mb-6 border border-gray-100 dark:border-slate-700"
    >
      <div className="w-full flex flex-col">
        <AnimatePresence>
          {players.map((p, idx) => {
            const isMe = isOnline ? p.name === myName : true;
            return (
              <motion.div
                key={p.id ?? p.name}
                layout
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className={`flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-white dark:bg-slate-800/50 transition-colors ${isOnline && isMe ? 'bg-indigo-50/50' : ''}`}
              >
                <div className="font-semibold flex items-center gap-2" style={{ color: p.color || '#1f2937' }}>
                  {isMe ? (
                    <input
                      type="color"
                      value={p.color || '#ffffff'}
                      onChange={(e) => changeColor(p, e.target.value)}
                      className={`w-6 h-6 p-0 border-0 bg-transparent align-middle cursor-pointer ${!isOnline ? 'mr-1' : ''}`}
                    />
                  ) : (
                    <span className="inline-block w-4 h-4 rounded-full shadow-sm border border-black/10" style={{ backgroundColor: p.color || '#ffffff' }} />
                  )}
                  {p.name}
                  {isOnline && p.socketId === hostId && <Crown size={16} className="text-amber-500" />}
                  {p.winStreak !== undefined && p.winStreak >= 3 && (
                    <span title={t('lobby.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak: p.winStreak })} className="text-amber-500 text-xs font-bold bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/50 flex items-center gap-0.5 whitespace-nowrap">
                      🔥 {p.winStreak}
                    </span>
                  )}
                  {p.disconnected && <span className="text-red-500 text-xs ml-1 font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50">{t('lobby.disconnected', 'Disconnected')}</span>}
                </div>
                <div className="whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    {isHost && (
                      <div className="w-[68px] flex items-center justify-center gap-1">
                        {/* disabled accompanies aria-hidden: an aria-hidden element
                            must not stay focusable (WCAG) — without it, a keyboard
                            user can Tab onto an invisible (opacity-0) button. */}
                        <button
                          className={`text-gray-500 dark:text-gray-400 w-8 h-8 flex items-center justify-center rounded transition-colors ${idx === 0 ? 'opacity-0' : 'hover:bg-gray-100 active:bg-gray-200 dark:hover:bg-slate-700 dark:active:bg-slate-600'}`}
                          onClick={(e) => { e.currentTarget.blur(); if (idx > 0) handleMoveUp(idx); }}
                          aria-hidden={idx === 0}
                          disabled={idx === 0}
                        >
                          <ChevronUp size={18} />
                        </button>
                        <button
                          className={`text-gray-500 dark:text-gray-400 w-8 h-8 flex items-center justify-center rounded transition-colors ${idx === players.length - 1 ? 'opacity-0' : 'hover:bg-gray-100 active:bg-gray-200 dark:hover:bg-slate-700 dark:active:bg-slate-600'}`}
                          onClick={(e) => { e.currentTarget.blur(); if (idx < players.length - 1) handleMoveDown(idx); }}
                          aria-hidden={idx === players.length - 1}
                          disabled={idx === players.length - 1}
                        >
                          <ChevronDown size={18} />
                        </button>
                      </div>
                    )}
                    <div className="w-8 h-8 flex items-center justify-center ml-1">
                      {(!isOnline || (isHost && p.socketId !== hostId)) && (
                        <button className="text-red-500 hover:bg-red-100 active:bg-red-200 dark:hover:bg-red-900/40 dark:active:bg-red-900/60 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => onRemovePlayer(p)}>
                          {isOnline ? <UserMinus size={18} /> : <Trash2 size={18} />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

interface DiceModeSelectorProps {
  diceMode: DiceMode;
  setDiceMode: (mode: DiceMode) => void;
  nameSuffix?: string;
}

export function DiceModeSelector({ diceMode, setDiceMode, nameSuffix = 'Lobby' }: DiceModeSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`diceMode${nameSuffix}`} checked={diceMode === 'digital'} onChange={() => setDiceMode('digital')} />
        <span className="font-medium">{t('lobby.digitalDice', 'Digital Dice')}</span>
      </label>
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`diceMode${nameSuffix}`} checked={diceMode === 'physical'} onChange={() => setDiceMode('physical')} />
        <span className="font-medium">{t('lobby.physicalDice', 'Physical Dice')}</span>
      </label>
    </div>
  );
}

interface EnforceDiceModeToggleProps {
  // The host's own current diceMode — becomes the value enforced for
  // everyone the moment the checkbox is checked (see setDiceMode in
  // configSlice.ts for how it keeps following the host's choice afterward).
  diceMode: DiceMode;
  enforcedDiceMode: DiceMode | null;
  setEnforcedDiceMode: (val: DiceMode | null) => void;
}

// Host-only control: renders nothing for non-host viewers. The read-only
// counterpart guests see instead (when enforcement is on) lives inline in
// OnlineLobby, next to where their own now-inert DiceModeSelector would be.
export function EnforceDiceModeToggle({ diceMode, enforcedDiceMode, setEnforcedDiceMode }: EnforceDiceModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
      <label className="checkbox-wrapper text-gray-700 dark:text-gray-200">
        <input
          type="checkbox"
          checked={enforcedDiceMode !== null}
          onChange={(e) => setEnforcedDiceMode(e.target.checked ? diceMode : null)}
        />
        <span className="font-medium">{t('lobby.enforceDiceMode', 'Enforce dice mode for all players')}</span>
      </label>
    </div>
  );
}

interface DiceModeEnforcedBadgeProps {
  enforcedDiceMode: DiceMode;
}

// Read-only view shown to non-host players in place of their own
// DiceModeSelector once the host has pinned a mode — their personal
// preference no longer has any effect on gameplay, so the selector would be
// misleading rather than merely inert.
export function DiceModeEnforcedBadge({ enforcedDiceMode }: DiceModeEnforcedBadgeProps) {
  const { t } = useTranslation();
  const modeLabel = enforcedDiceMode === 'digital'
    ? t('lobby.digitalDice', 'Digital Dice')
    : t('lobby.physicalDice', 'Physical Dice');
  return (
    <div className="flex items-center justify-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-4 py-3 sm:px-6 rounded-xl border border-indigo-100 dark:border-indigo-800 h-full min-h-[50px] font-medium">
      {t('lobby.diceModeEnforcedBadge', 'Dice Mode: {{mode}} (set by host)', { mode: modeLabel })}
    </div>
  );
}

interface AudioSettingSelectorProps {
  audioEnabled: boolean;
  setAudioEnabled: (val: boolean) => void;
  nameSuffix?: string;
}

export function AudioSettingSelector({ audioEnabled, setAudioEnabled, nameSuffix = 'Lobby' }: AudioSettingSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`audioSetting${nameSuffix}`} checked={audioEnabled === true} onChange={() => setAudioEnabled(true)} />
        <span className="font-medium">{t('lobby.soundOn', 'Sound On')}</span>
      </label>
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`audioSetting${nameSuffix}`} checked={audioEnabled === false} onChange={() => setAudioEnabled(false)} />
        <span className="font-medium">{t('lobby.muted', 'Muted')}</span>
      </label>
    </div>
  );
}

interface HapticsSettingSelectorProps {
  hapticsEnabled: boolean;
  setHapticsEnabled: (val: boolean) => void;
  nameSuffix?: string;
}

export function HapticsSettingSelector({ hapticsEnabled, setHapticsEnabled, nameSuffix = 'Lobby' }: HapticsSettingSelectorProps) {
  const { t } = useTranslation();

  // iOS (Safari and every other browser there, all WebKit) has never
  // implemented the Vibration API, but supportsIOSSwitchHaptic() covers the
  // one working fallback there (see iosSwitchHaptic.ts). Hide the toggle
  // only when NEITHER path is available — otherwise it's a setting that
  // visibly exists but can never do anything, which just reads as broken.
  const hasVibrationSupport = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  if (!hasVibrationSupport && !supportsIOSSwitchHaptic()) return null;

  return (
    <div className="flex sm:hidden flex-wrap items-center justify-center gap-2 sm:gap-6 bg-white dark:bg-slate-800/50 px-3 py-2 sm:px-6 sm:py-3 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`hapticsSetting${nameSuffix}`} checked={hapticsEnabled === true} onChange={() => setHapticsEnabled(true)} />
        <span className="font-medium">{t('lobby.hapticsOn', 'Vibration On')}</span>
      </label>
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input type="radio" name={`hapticsSetting${nameSuffix}`} checked={hapticsEnabled === false} onChange={() => setHapticsEnabled(false)} />
        <span className="font-medium">{t('lobby.hapticsOff', 'Vibration Off')}</span>
      </label>
    </div>
  );
}

interface AdvancedOptionsToggleProps {
  showAdvanced: boolean;
  setShowAdvanced: (val: boolean) => void;
}

export function AdvancedOptionsToggle({ showAdvanced, setShowAdvanced }: AdvancedOptionsToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      className="flex items-center justify-center gap-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800/50 hover:bg-gray-50 dark:hover:bg-slate-800 px-4 py-3 rounded-xl font-medium transition-colors border border-gray-200 dark:border-slate-600 h-full min-h-[50px]"
      onClick={() => setShowAdvanced(!showAdvanced)}
    >
      <Settings size={18} /> {showAdvanced ? t('lobby.hideAdvancedOptions', 'Hide Advanced Options') : t('lobby.showAdvancedOptions', 'Show Advanced Options')}
    </button>
  );
}

interface AdvancedOptionsPanelProps {
  showAdvanced: boolean;
  isOnline?: boolean;
  readOnly?: boolean;
  onResetGeneralSettings?: (() => void) | null;
  onResetCards?: (() => void) | null;
}

interface BlurInputProps extends InputHTMLAttributes<HTMLInputElement> {
  value: number;
  onValueChange: (val: number) => void;
  minVal?: number;
  maxVal?: number;
  // Applied after clamping — for fields whose valid range has a hole that a
  // min/max pair can't express (e.g. the "0 = disabled, otherwise >= 10" timers).
  normalize?: (val: number) => number;
}

function BlurInput({ value, onValueChange, minVal = 0, maxVal = 99999, normalize, ...props }: BlurInputProps) {
  const [localValue, setLocalValue] = useState((value ?? 0).toString());
  const [prevValue, setPrevValue] = useState(value);
  const [isDirty, setIsDirty] = useState(false);

  // Synchronous render-time derived state (same pattern as GameControls): when
  // the committed value changes from outside (reset buttons, a server update),
  // adopt it and drop any uncommitted edit.
  if (value !== prevValue) {
    setPrevValue(value);
    setLocalValue((value ?? 0).toString());
    setIsDirty(false);
  }

  const commit = () => {
    if (!isDirty) return;
    let parsed = parseInt(localValue, 10);
    if (isNaN(parsed)) parsed = value ?? 0;
    const clamped = Math.min(maxVal, Math.max(minVal, parsed));
    const committed = normalize ? normalize(clamped) : clamped;
    setIsDirty(false);

    if (committed !== value) {
      onValueChange(committed);
    }
    // Fall back to the value the OWNER currently holds rather than optimistically
    // displaying `committed`. An accepted edit changes `value`, and the
    // render-time sync above then adopts it — but an owner may legitimately
    // refuse the write (zeroing the last non-zero card type leaves the deck
    // unplayable, so validateOnlineConfig drops initialCards outright), in which
    // case `value` never changes, the sync never fires, and the field would keep
    // showing a number the game isn't actually using.
    setLocalValue((value ?? 0).toString());
  };

  const handleBlur = () => commit();
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  return (
    <input
      {...props}
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value);
        setIsDirty(true);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}

export function AdvancedOptionsPanel({
  showAdvanced,
  isOnline = false,
  readOnly = false,
  onResetGeneralSettings = null,
  onResetCards = null,
}: AdvancedOptionsPanelProps) {
  const { t } = useTranslation();

  // Subscribes to its own config slice instead of receiving the whole store
  // as a prop from the lobbies (which forced them to drill it through).
  const {
    winningScore, setWinningScore, turnDuration, setTurnDuration,
    reconnectTimeout, setReconnectTimeout, randomOrder, setRandomOrder,
    enforcedDiceMode, initialCards, setInitialCards,
  } = useGameStore(useShallow((s) => ({
    winningScore: s.winningScore,
    setWinningScore: s.setWinningScore,
    turnDuration: s.turnDuration,
    setTurnDuration: s.setTurnDuration,
    reconnectTimeout: s.reconnectTimeout,
    setReconnectTimeout: s.setReconnectTimeout,
    randomOrder: s.randomOrder,
    setRandomOrder: s.setRandomOrder,
    enforcedDiceMode: s.enforcedDiceMode,
    initialCards: s.initialCards,
    setInitialCards: s.setInitialCards,
  })));

  const updateCardCount = (card: string, count: number) => {
    setInitialCards({ ...initialCards, [card as CardType]: count });
  };

  return (
    <AnimatePresence>
      {showAdvanced && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden mb-8"
        >
          {readOnly ? (
            <div className="bg-white dark:bg-slate-800/40 p-3 sm:p-5 rounded-xl border border-gray-200 dark:border-slate-600">
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                  {t('lobby.winningScore', 'Winning Score')}: <strong>{winningScore}</strong>
                </span>
                {isOnline && (
                  <>
                    <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                      {t('lobby.turnTimer', 'Turn Timer')}: <strong>{turnDuration > 0 ? `${turnDuration}s` : t('common.disabled', 'Disabled')}</strong>
                    </span>
                    <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                      {t('lobby.kickTimer', 'Kick Timer')}: <strong>{reconnectTimeout > 0 ? `${reconnectTimeout}s` : t('common.disabled', 'Disabled')}</strong>
                    </span>
                  </>
                )}
                <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                  {t('lobby.randomOrder', 'Random Order')}: <strong>{randomOrder !== false ? t('game.controls.yes', 'Yes') : t('game.controls.no', 'No')}</strong>
                </span>
                {isOnline && enforcedDiceMode && (
                  <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                    {t('lobby.diceMode', 'Dice Mode')}: <strong>{enforcedDiceMode === 'digital' ? t('lobby.digitalDice', 'Digital Dice') : t('lobby.physicalDice', 'Physical Dice')}</strong>
                  </span>
                )}
              </div>
              <div className="pt-4 border-t border-gray-200 dark:border-slate-600">
                <h4 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
                <div className="flex flex-wrap gap-2">
                  {initialCards && Object.entries(initialCards).map(([card, count]) => (
                    <span key={card} className="px-2.5 py-1 bg-gray-100 dark:bg-slate-700/50 text-gray-700 dark:text-gray-300 rounded-md text-sm font-medium border border-gray-200 dark:border-slate-600">
                      {card.replace('_', '/')}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800/40 p-3 sm:p-6 rounded-xl border border-gray-200 dark:border-slate-600">
              <div className="flex items-center justify-between mb-4">
                <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 mb-0 flex-1">{t('lobby.generalSettings', 'General Settings')}</h4>
                {onResetGeneralSettings && (
                  <button
                    onClick={onResetGeneralSettings}
                    className="flex items-center p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 transition-colors"
                    title={t('lobby.resetGeneralSettings', 'Reset General Settings to Default Values')}
                  >
                    <RotateCcw size={18} />
                    <span className="ml-1 text-xs font-medium inline">{t('lobby.defaultValues', 'default values')}</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3 mb-6 items-stretch">
                <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.winningScore', 'Winning Score')}</span>
                  <BlurInput
                    type="number" minVal={MIN_WINNING_SCORE} maxVal={MAX_WINNING_SCORE} inputMode="numeric" pattern="[0-9]*"
                    className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                    value={winningScore}
                    onValueChange={(val) => setWinningScore(val)}
                  />
                </label>
                {isOnline && (
                  <>
                    <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                      <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.turnTimer', 'Turn Timer (s)')}</span>
                      <BlurInput
                        type="number" minVal={0} maxVal={MAX_TURN_DURATION} inputMode="numeric" pattern="[0-9]*"
                        normalize={(val) => snapDisableableDuration(val, MIN_ENABLED_TURN_DURATION)}
                        className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                        value={turnDuration}
                        onValueChange={(val) => setTurnDuration(val)}
                        placeholder="0"
                      />
                    </label>
                    <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                      <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.kickTimer', 'Kick Timer (s)')}</span>
                      <BlurInput
                        type="number" minVal={0} maxVal={MAX_RECONNECT_TIMEOUT} inputMode="numeric" pattern="[0-9]*"
                        normalize={(val) => snapDisableableDuration(val, MIN_ENABLED_RECONNECT_TIMEOUT)}
                        className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium"
                        value={reconnectTimeout}
                        onValueChange={(val) => setReconnectTimeout(val)}
                        placeholder="0"
                      />
                    </label>
                  </>
                )}
                <div
                  onClick={() => setRandomOrder(!randomOrder)}
                  className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2 py-1">{t('lobby.randomOrder', 'Random Order')}</span>
                  <div className={`w-10 h-5 rounded-full flex items-center p-0.5 transition-colors ${randomOrder !== false ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                    <motion.div
                      layout
                      transition={{ type: 'spring', stiffness: 700, damping: 30 }}
                      className="w-4 h-4 bg-white rounded-full shadow-sm"
                      style={{ marginLeft: randomOrder !== false ? '20px' : '0px' }}
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mb-4">
                <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 mb-0 flex-1">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
                {onResetCards && (
                  <button
                    onClick={onResetCards}
                    className="flex items-center p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400 transition-colors ml-2"
                    title={t('lobby.resetCardsInDeck', 'Reset Cards in Deck to Default Values')}
                  >
                    <RotateCcw size={18} />
                    <span className="ml-1 text-xs font-medium inline">{t('lobby.defaultValues', 'default values')}</span>
                  </button>
                )}
              </div>
              <div data-testid="deck-composition-grid" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
                {initialCards && Object.entries(initialCards).map(([card, count]) => (
                  <label key={card} className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{card.replace('_', '/')}</span>
                    <BlurInput
                      type="number" minVal={0} maxVal={MAX_CARD_COUNT} inputMode="numeric" pattern="[0-9]*"
                      className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-16 py-1 text-gray-900 dark:text-white font-medium"
                      value={count}
                      onValueChange={(val) => updateCardCount(card, val)}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface StartGameButtonProps {
  startGame: () => void;
  playersCount: number;
  disabled?: boolean;
  // Overrides the default "need players" / "waiting to reconnect" message —
  // needed for reasons those two don't cover (e.g. an empty deck), and to
  // avoid showing the 2-player message in local mode, which never required it.
  disabledMessage?: string;
}

export function StartGameButton({ startGame, playersCount, disabled = false, disabledMessage }: StartGameButtonProps) {
  const { t } = useTranslation();
  const fallbackMessage = playersCount < 2
    ? t('lobby.needAtLeast2Players', 'Need at least 2 players')
    : t('lobby.waitingForPlayersToReconnect', 'Waiting for players to reconnect...');
  return (
    <AnimatePresence>
      {playersCount > 0 && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="flex justify-center"
        >
          <motion.button
            whileHover={!disabled ? { scale: 1.05 } : {}}
            whileTap={!disabled ? { scale: 0.95 } : {}}
            className={`w-full py-4 rounded-xl text-xl font-bold flex justify-center items-center gap-3 transition-colors ${disabled ? 'bg-gray-400 text-gray-200 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'}`}
            onClick={startGame}
            disabled={disabled}
          >
            <Play size={24} /> {disabled ? (disabledMessage ?? fallbackMessage) : t('lobby.startGame', 'Start Game!')}
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
