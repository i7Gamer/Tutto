import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { DiceModeSelector, RulesetSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton, PlayerList, AudioSettingSelector, HapticsSettingSelector } from './LobbyShared';
import { hasPlayableDeck } from '../../utils/coreGameEngine';
import { MAX_PLAYER_NAME_LENGTH } from '../../utils/configValidation';
import { useGameStore } from '../../store/useGameStore';

export default function LocalLobby() {
  const { t } = useTranslation();
  const [newPlayerName, setNewPlayerName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Selects only what this lobby renders — the whole store used to arrive as
  // a prop from Home, re-rendering the entire lobby tree on any store change.
  const {
    players, addPlayer, removePlayer, startGame, reorderPlayers, changePlayerColor,
    diceMode, setDiceMode, audioEnabled, setAudioEnabled, hapticsEnabled, setHapticsEnabled,
    initialCards, resetGeneralSettings, resetInitialCards, addToast,
    ruleset, setRuleset,
  } = useGameStore(useShallow((s) => ({
    players: s.players,
    addPlayer: s.addPlayer,
    removePlayer: s.removePlayer,
    startGame: s.startGame,
    reorderPlayers: s.reorderPlayers,
    changePlayerColor: s.changePlayerColor,
    diceMode: s.diceMode,
    setDiceMode: s.setDiceMode,
    audioEnabled: s.audioEnabled,
    setAudioEnabled: s.setAudioEnabled,
    hapticsEnabled: s.hapticsEnabled,
    setHapticsEnabled: s.setHapticsEnabled,
    initialCards: s.initialCards,
    resetGeneralSettings: s.resetGeneralSettings,
    resetInitialCards: s.resetInitialCards,
    addToast: s.addToast,
    ruleset: s.ruleset,
    setRuleset: s.setRuleset,
  })));

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
        <AudioSettingSelector audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} nameSuffix="Local" />
        <HapticsSettingSelector hapticsEnabled={hapticsEnabled} setHapticsEnabled={setHapticsEnabled} nameSuffix="Local" />
        <AdvancedOptionsToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
      </div>

      <AdvancedOptionsPanel
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
