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
    <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 bg-white dark:bg-slate-800/50 px-4 py-3 sm:px-6 rounded-xl border border-gray-200 dark:border-slate-600 h-full min-h-[50px]">
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
      className="flex items-center justify-center gap-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800/50 hover:bg-gray-50 dark:hover:bg-slate-800 px-4 py-3 rounded-xl font-medium transition-colors border border-gray-200 dark:border-slate-600 h-full min-h-[50px]" 
      onClick={() => setShowAdvanced(!showAdvanced)}
    >
      <Settings size={18} /> {showAdvanced ? t('lobby.hideAdvancedOptions', 'Hide Advanced Options') : t('lobby.showAdvancedOptions', 'Show Advanced Options')}
    </button>
  );
}

export function AdvancedOptionsPanel({ 
  showAdvanced, 
  game, 
  isOnline = false,
  readOnly = false
}) {
  const { t } = useTranslation();
  const updateCardCount = (card, count) => {
    if (game.setInitialCards) {
      game.setInitialCards({ ...game.initialCards, [card]: Math.max(0, parseInt(count) || 0) });
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
          {readOnly ? (
            <div className="bg-white dark:bg-slate-800/40 p-4 sm:p-5 rounded-xl border border-gray-200 dark:border-slate-600">
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                  {t('lobby.winningScore', 'Winning Score')}: <strong>{game.winningScore}</strong>
                </span>
                {isOnline && (
                  <>
                    <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                      {t('lobby.turnTimer', 'Turn Timer')}: <strong>{game.turnDuration > 0 ? `${game.turnDuration}s` : t('common.disabled', 'Disabled')}</strong>
                    </span>
                    <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                      {t('lobby.kickTimer', 'Kick Timer')}: <strong>{game.reconnectTimeout > 0 ? `${game.reconnectTimeout}s` : t('common.disabled', 'Disabled')}</strong>
                    </span>
                  </>
                )}
                <span className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-medium border border-indigo-100 dark:border-indigo-800">
                  {t('lobby.randomOrder', 'Random Order')}: <strong>{game.randomOrder !== false ? t('game.controls.yes', 'Yes') : t('game.controls.no', 'No')}</strong>
                </span>
              </div>
              
              <div className="pt-4 border-t border-gray-200 dark:border-slate-600">
                <h4 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
                <div className="flex flex-wrap gap-2">
                  {game.initialCards && Object.entries(game.initialCards).map(([card, count]) => (
                    <span key={card} className="px-2.5 py-1 bg-gray-100 dark:bg-slate-700/50 text-gray-700 dark:text-gray-300 rounded-md text-sm font-medium border border-gray-200 dark:border-slate-600">
                      {card.replace("_", "/")}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800/40 p-4 sm:p-6 rounded-xl border border-gray-200 dark:border-slate-600">
            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6 items-end`}>
              <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.winningScore', 'Winning Score')}</span>
                <input 
                  type="number" 
                  min="0"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium" 
                  value={game.winningScore} 
                  onChange={(e) => game.setWinningScore(Math.max(0, parseInt(e.target.value) || 0))} 
                />
              </label>

              {isOnline && (
                <>
                  <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.turnTimer', 'Turn Timer (s)')}</span>
                    <input 
                      type="number" 
                      min="0"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium" 
                      value={game.turnDuration} 
                      onChange={(e) => game.setTurnDuration(Math.max(0, parseInt(e.target.value) || 0))} 
                      placeholder="0" 
                    />
                  </label>
                  <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text">
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{t('lobby.kickTimer', 'Kick Timer (s)')}</span>
                    <input 
                      type="number" 
                      min="0"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-24 py-1 text-gray-900 dark:text-white font-medium" 
                      value={game.reconnectTimeout} 
                      onChange={(e) => game.setReconnectTimeout(Math.max(0, parseInt(e.target.value) || 0))} 
                      placeholder="0" 
                    />
                  </label>
                </>
              )}

              <div 
                onClick={() => game.setRandomOrder(!game.randomOrder)} 
                className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
              >
                <span className="text-sm font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">
                  {t('lobby.randomOrder', 'Random Order')}
                </span>
                <div className={`w-10 h-5 rounded-full flex items-center p-0.5 transition-colors ${game.randomOrder !== false ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                  <motion.div 
                    layout 
                    transition={{ type: "spring", stiffness: 700, damping: 30 }}
                    className="w-4 h-4 bg-white rounded-full shadow-sm" 
                    style={{ marginLeft: game.randomOrder !== false ? '20px' : '0px' }} 
                  />
                </div>
              </div>
            </div>

            <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 mb-4">{t('lobby.cardsInDeck', 'Cards in Deck')}</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
              {game.initialCards && Object.keys(game.initialCards).map(card => (
                <label className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-lg px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-colors cursor-text" key={card}>
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis mr-2">{card.replace("_", "/")}</span>
                  <input 
                    type="number" 
                    min="0"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="bg-transparent border-0 outline-none focus:outline-none focus:ring-0 focus:border-transparent shadow-none text-right w-20 py-1 text-gray-900 dark:text-white font-medium text-base" 
                    value={game.initialCards[card]} 
                    onChange={(e) => updateCardCount(card, e.target.value)} 
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
