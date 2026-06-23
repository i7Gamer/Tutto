import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Play, ChevronUp, ChevronDown, Trash2, UserMinus, Crown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function PlayerList({
  players,
  reorderPlayers,
  isOnline = false,
  myName = null,
  hostId = null,
  isHost = true,
  changeColor,
  onRemovePlayer
}) {
  const { t } = useTranslation();

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newPlayers = [...players];
    [newPlayers[index - 1], newPlayers[index]] = [newPlayers[index], newPlayers[index - 1]];
    if (reorderPlayers) reorderPlayers(newPlayers);
  };

  const handleMoveDown = (index) => {
    if (index === players.length - 1) return;
    const newPlayers = [...players];
    [newPlayers[index + 1], newPlayers[index]] = [newPlayers[index], newPlayers[index + 1]];
    if (reorderPlayers) reorderPlayers(newPlayers);
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
                key={p.name}
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
                    <span className="inline-block w-4 h-4 rounded-full shadow-sm border border-black/10" style={{ backgroundColor: p.color || '#ffffff' }}></span>
                  )}
                  {p.name} 
                  {isOnline && p.socketId === hostId && <Crown size={16} className="text-amber-500" />}
                  {p.disconnected && <span className="text-red-500 text-xs ml-1 font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50">{t('lobby.disconnected', 'Disconnected')}</span>}
                </div>
                <div className="whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    {isHost && (
                        <div className="w-[68px] flex items-center justify-center gap-1">
                          {idx > 0 && (
                            <button className="text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 w-8 h-8 flex items-center justify-center rounded transition-colors" onClick={() => handleMoveUp(idx)}>
                              <ChevronUp size={18} />
                            </button>
                          )}
                          {idx < players.length - 1 && (
                            <button className="text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 w-8 h-8 flex items-center justify-center rounded transition-colors" onClick={() => handleMoveDown(idx)}>
                              <ChevronDown size={18} />
                            </button>
                          )}
                        </div>
                    )}
                    <div className="w-8 h-8 flex items-center justify-center ml-1">
                      {(!isOnline || (isHost && p.socketId !== hostId)) && (
                        <button className="text-red-500 hover:bg-red-100 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => onRemovePlayer(p)}>
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

export function DiceModeSelector({ diceMode, setDiceMode, nameSuffix = "Lobby" }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600">
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input 
          type="radio" 
          name={`diceMode${nameSuffix}`}
          checked={diceMode === 'digital'} 
          onChange={() => setDiceMode('digital')} 
        />
        <span className="font-medium">{t('lobby.digitalDice', 'Digital Dice')}</span>
      </label>
      <label className="radio-wrapper text-gray-700 dark:text-gray-200">
        <input 
          type="radio" 
          name={`diceMode${nameSuffix}`}
          checked={diceMode === 'physical'} 
          onChange={() => setDiceMode('physical')} 
        />
        <span className="font-medium">{t('lobby.physicalDice', 'Physical Dice')}</span>
      </label>
    </div>
  );
}

export function AdvancedOptionsToggle({ showAdvanced, setShowAdvanced }) {
  const { t } = useTranslation();
  return (
    <button 
      className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800/50 hover:bg-gray-50 dark:hover:bg-slate-800 px-4 py-2 rounded-lg font-medium transition-colors border border-gray-200 dark:border-slate-600" 
      onClick={() => setShowAdvanced(!showAdvanced)}
    >
      <Settings size={18} /> {showAdvanced ? t('lobby.hide', 'Hide') : t('lobby.show', 'Show')} {t('lobby.advancedOptions', 'Advanced Options')}
    </button>
  );
}

export function AdvancedOptionsPanel({ 
  showAdvanced, 
  game, 
  isOnline = false 
}) {
  const { t } = useTranslation();
  const updateCardCount = (card, count) => {
    if (game.setInitialCards) {
      game.setInitialCards({ ...game.initialCards, [card]: parseInt(count) || 0 });
    }
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
          <div className="bg-white dark:bg-slate-800/40 p-4 sm:p-6 rounded-xl border border-gray-200 dark:border-slate-600">
            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6 items-end`}>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('lobby.winningScore', 'Winning Score')}</label>
                <input 
                  type="number" 
                  className="bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
                  value={game.winningScore} 
                  onChange={(e) => game.setWinningScore(parseInt(e.target.value) || 0)} 
                />
              </div>

              {isOnline && (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('lobby.turnTimer', 'Turn Timer (s)')}</label>
                    <input 
                      type="number" 
                      className="bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
                      value={game.turnDuration} 
                      onChange={(e) => game.setTurnDuration(parseInt(e.target.value) || 0)} 
                      placeholder={t('lobby.zeroToDisable', '0 to disable')} 
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('lobby.kickTimer', 'Kick Timer (s)')} <span className="text-[10px] italic opacity-70 ml-1">{t('lobby.disconnect', '(disconnect)')}</span></label>
                    <input 
                      type="number" 
                      className="bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
                      value={game.reconnectTimeout} 
                      onChange={(e) => game.setReconnectTimeout(parseInt(e.target.value) || 0)} 
                    />
                  </div>
                </>
              )}

              <div className={`flex items-center gap-2 pb-2`}>
                <label htmlFor={isOnline ? "onlineRandomOrder" : "localRandomOrder"} className="checkbox-wrapper text-gray-700 dark:text-gray-200">
                  <input 
                    type="checkbox" 
                    id={isOnline ? "onlineRandomOrder" : "localRandomOrder"} 
                    checked={game.randomOrder ?? true} 
                    onChange={(e) => game.setRandomOrder(e.target.checked)} 
                  />
                  <span className="font-medium text-sm sm:text-base">{t('lobby.randomOrder', 'Random Order')}</span>
                </label>
              </div>
            </div>

            <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 mb-4">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {game.initialCards && Object.keys(game.initialCards).map(card => (
                <div className="flex flex-col gap-1" key={card}>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400">{card.replace("_", "/")}</label>
                  <input 
                    type="number" 
                    className="bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-md px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" 
                    value={game.initialCards[card]} 
                    onChange={(e) => updateCardCount(card, e.target.value)} 
                  />
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function StartGameButton({ startGame, playersCount, disabled = false }) {
  const { t } = useTranslation();
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
            <Play size={24} /> {disabled ? (playersCount < 2 ? t('lobby.needAtLeast2Players', "Need at least 2 players") : t('lobby.waitingForPlayersToReconnect', "Waiting for players to reconnect...")) : t('lobby.startGame', "Start Game!")}
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
