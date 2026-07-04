import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DiceModeSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton, PlayerList, AudioSettingSelector, HapticsSettingSelector } from './LobbyShared';
import { hasPlayableDeck } from '../../utils/coreGameEngine';
import type { GameStore } from '../../store/useGameStore';

interface LocalLobbyProps {
  game: GameStore;
}

export default function LocalLobby({ game }: LocalLobbyProps) {
  const { t } = useTranslation();
  const [newPlayerName, setNewPlayerName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { players, addPlayer, removePlayer, startGame, reorderPlayers, changePlayerColor } = game;

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (trimmedName === '') return;
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      alert(t('lobby.playerExistsAlert', 'A player with this name already exists!'));
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
            placeholder={t('lobby.newPlayerPlaceholder', 'Name of new player')}
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
            className="flex-1 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
          />
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors"
            onClick={handleAddPlayer}
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

      <div className="flex flex-row flex-wrap justify-center items-stretch gap-4 mb-8">
        <DiceModeSelector diceMode={game.diceMode} setDiceMode={game.setDiceMode} nameSuffix="Local" />
        <AudioSettingSelector audioEnabled={game.audioEnabled} setAudioEnabled={game.setAudioEnabled} nameSuffix="Local" />
        <HapticsSettingSelector hapticsEnabled={game.hapticsEnabled} setHapticsEnabled={game.setHapticsEnabled} nameSuffix="Local" />
        <AdvancedOptionsToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
      </div>

      <AdvancedOptionsPanel
        showAdvanced={showAdvanced}
        game={game}
        isOnline={false}
        onResetGeneralSettings={() => game.resetGeneralSettings()}
        onResetCards={() => game.resetInitialCards()}
      />

      <StartGameButton
        startGame={startGame}
        playersCount={players ? players.length : 0}
        disabled={!hasPlayableDeck(game.initialCards)}
        disabledMessage={!hasPlayableDeck(game.initialCards) ? t('lobby.emptyDeck', 'Add at least one card to the deck') : undefined}
      />
    </motion.div>
  );
}
