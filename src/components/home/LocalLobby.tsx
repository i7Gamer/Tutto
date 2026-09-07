import { useEffect, useId, useState } from 'react';
import { UserPlus, Bot } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { DiceModeSelector, RulesetSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton, PlayerList, AudioSettingSelector, HapticsSettingSelector, AnimationsSettingSelector } from './LobbyShared';
import { hasPlayableDeck } from '../../utils/coreGameEngine';
import { MAX_PLAYER_NAME_LENGTH } from '../../utils/configValidation';
import { BOT_NAMES } from '../../utils/bots';
import { BOT_PERSONALITIES, type BotPersonality } from '../../types';
import { useGameStore } from '../../store/useGameStore';
import { setHasFormDraft } from '../../utils/uiBusyState';

export default function LocalLobby() {
  const { t } = useTranslation();
  const [newPlayerName, setNewPlayerName] = useState('');
  // A half-typed name is state a service-worker reload would drop, so it
  // counts as a form draft for the update idle check — the online lobby
  // reports its join form the same way. Cleared on unmount: a lobby that is
  // not mounted holds no draft.
  useEffect(() => { setHasFormDraft(newPlayerName.trim().length > 0); }, [newPlayerName]);
  useEffect(() => () => setHasFormDraft(false), []);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedOptionsPanelId = useId();
  // Selects only what this lobby renders — the whole store used to arrive as
  // a prop from Home, re-rendering the entire lobby tree on any store change.
  const {
    players, addPlayer, addBot, removePlayer, startGame, reorderPlayers, changePlayerColor,
    diceMode, setDiceMode, audioEnabled, setAudioEnabled, audioVolume, setAudioVolume, hapticsEnabled, setHapticsEnabled,
    motionOverride, setMotionOverride,
    initialCards, resetGeneralSettings, resetInitialCards, addToast,
    ruleset, setRuleset,
  } = useGameStore(useShallow((s) => ({
    players: s.players,
    addPlayer: s.addPlayer,
    addBot: s.addBot,
    removePlayer: s.removePlayer,
    startGame: s.startGame,
    reorderPlayers: s.reorderPlayers,
    changePlayerColor: s.changePlayerColor,
    diceMode: s.diceMode,
    setDiceMode: s.setDiceMode,
    audioEnabled: s.audioEnabled,
    setAudioEnabled: s.setAudioEnabled,
    audioVolume: s.audioVolume,
    setAudioVolume: s.setAudioVolume,
    hapticsEnabled: s.hapticsEnabled,
    setHapticsEnabled: s.setHapticsEnabled,
    motionOverride: s.motionOverride,
    setMotionOverride: s.setMotionOverride,
    initialCards: s.initialCards,
    resetGeneralSettings: s.resetGeneralSettings,
    resetInitialCards: s.resetInitialCards,
    addToast: s.addToast,
    ruleset: s.ruleset,
    setRuleset: s.setRuleset,
  })));

  // Literal keys on purpose: translations.test only sees the calls it can
  // read as written, so a key built from the personality would escape it.
  const personalityLabel: Record<BotPersonality, string> = {
    cautious: t('lobby.botCautious', 'Cautious'),
    risky: t('lobby.botRisky', 'Risk-taker'),
    optimal: t('lobby.botOptimal', 'Calculating'),
  };
  // A bot's name is reserved (utils/bots.ts); its button greys out while the
  // name sits at the table, whoever holds it — the store would refuse the
  // seat anyway, this just says so up front.
  const isNameSeated = (name: string) => players.some(p => p.name.toLowerCase() === name.toLowerCase());

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (trimmedName === '') return;
    // Same 30-char cap the server enforces on the online path (joinRoom) —
    // LocalLobby has no server round-trip to catch an oversized name, so it
    // must reject it here instead of letting it distort every roster/
    // leaderboard render and get persisted to localStorage as-is.
    if (trimmedName.length > MAX_PLAYER_NAME_LENGTH) {
      addToast(t('lobby.playerNameTooLongAlert', { defaultValue: 'Player name must be {{max}} characters or fewer', max: MAX_PLAYER_NAME_LENGTH }));
      return;
    }
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      // Toasted instead of a blocking window.alert(), consistent with the
      // rest of the app's non-blocking notifications.
      addToast(t('lobby.playerExistsAlert', 'A player with this name already exists!'));
      return;
    }
    addPlayer(trimmedName);
    setNewPlayerName('');
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <div className="mb-8">
        <h3 className="text-xl font-bold mb-4">{t('lobby.playersTitle', 'Players')}</h3>
        <div className="flex items-center gap-3 mb-6">
          <input
            type="text"
            maxLength={MAX_PLAYER_NAME_LENGTH}
            placeholder={t('lobby.newPlayerPlaceholder', 'Name of new player')}
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
            className="flex-1 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 transition-all"
          />
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors"
            onClick={handleAddPlayer}
            aria-label={t('lobby.addPlayerButton', 'Add')}
          >
            <UserPlus size={18} /> <span className="hidden sm:inline">{t('lobby.addPlayerButton', 'Add')}</span>
          </motion.button>
        </div>
        {/* Bots: one seat per personality, so playing alone is one tap away. */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <span className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5 mr-1">
            <Bot size={18} aria-hidden="true" /> {t('lobby.addBotTitle', 'Add a bot')}
          </span>
          {BOT_PERSONALITIES.map((personality) => {
            const name = BOT_NAMES[personality];
            return (
              <button
                key={personality}
                type="button"
                disabled={isNameSeated(name)}
                onClick={() => addBot(personality)}
                /* The name rides OUTSIDE t(): an interpolated name collapses to
                   one identical label for all three under the unit i18n mock. */
                aria-label={`${t('lobby.addBotButton', 'Add bot:')} ${name}`}
                title={`${t('lobby.addBotButton', 'Add bot:')} ${name}`}
                className="min-h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border border-gray-300 dark:border-slate-500 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-slate-800/60 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <span className="font-bold">{name}</span>
                <span className="text-gray-500 dark:text-gray-400">{personalityLabel[personality]}</span>
              </button>
            );
          })}
        </div>
        <PlayerList
          players={players}
          reorderPlayers={reorderPlayers}
          isOnline={false}
          isHost={true}
          changeColor={(p, color) => changePlayerColor(p.name, color)}
          onRemovePlayer={(p) => removePlayer(p.name)}
        />
      </div>

      <RulesetSelector ruleset={ruleset} setRuleset={setRuleset} nameSuffix="Local" />

      <div className="flex flex-row flex-wrap justify-center items-stretch gap-2 sm:gap-4 mb-8">
        <DiceModeSelector diceMode={diceMode} setDiceMode={setDiceMode} nameSuffix="Local" />
        <AudioSettingSelector audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} audioVolume={audioVolume} setAudioVolume={setAudioVolume} nameSuffix="Local" />
        <HapticsSettingSelector hapticsEnabled={hapticsEnabled} setHapticsEnabled={setHapticsEnabled} nameSuffix="Local" />
        <AnimationsSettingSelector motionOverride={motionOverride} setMotionOverride={setMotionOverride} nameSuffix="Local" />
        <AdvancedOptionsToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} panelId={advancedOptionsPanelId} />
      </div>

      <AdvancedOptionsPanel
        id={advancedOptionsPanelId}
        showAdvanced={showAdvanced}
        isOnline={false}
        onResetGeneralSettings={() => resetGeneralSettings()}
        onResetCards={() => resetInitialCards()}
      />

      <StartGameButton
        startGame={startGame}
        playersCount={players ? players.length : 0}
        disabled={(players ? players.length : 0) < 2 || !hasPlayableDeck(initialCards)}
        disabledMessage={!hasPlayableDeck(initialCards) ? t('lobby.emptyDeck', 'Add at least one card to the deck') : undefined}
      />
    </motion.div>
  );
}
