import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Play, ChevronUp, ChevronDown, Trash2, UserMinus, Crown } from 'lucide-react';

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
      <table className="w-full text-left border-collapse">
        <tbody>
          <AnimatePresence>
            {players.map((p, idx) => {
              const isMe = isOnline ? p.name === myName : true;
              return (
                <motion.tr 
                  key={p.name}
                  layout
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className={`border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-white dark:bg-slate-800/50 transition-colors ${isOnline && isMe ? 'bg-indigo-50/50' : ''}`}
                >
                  <td className="p-3 font-semibold flex items-center gap-2" style={{ color: p.color || '#1f2937' }}>
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
                    {p.disconnected && <span className="text-red-500 text-xs ml-1 font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50">Disconnected</span>}
                  </td>
                  <td className="p-3 whitespace-nowrap w-36">
                    <div className="flex items-center justify-end gap-1">
                      {isHost && (
                        <>
                          <div className="w-8 h-8 flex items-center justify-center">
                            {idx > 0 && (
                              <button className="text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => handleMoveUp(idx)}>
                                <ChevronUp size={18} />
                              </button>
                            )}
                          </div>
                          <div className="w-8 h-8 flex items-center justify-center">
                            {idx < players.length - 1 && (
                              <button className="text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => handleMoveDown(idx)}>
                                <ChevronDown size={18} />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                      <div className="w-8 h-8 flex items-center justify-center ml-1">
                        {(!isOnline || (isHost && p.socketId !== hostId)) && (
                          <button className="text-red-500 hover:bg-red-100 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => onRemovePlayer(p)}>
                            {isOnline ? <UserMinus size={18} /> : <Trash2 size={18} />}
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </motion.div>
  );
}

export function DiceModeSelector({ diceMode, setDiceMode, nameSuffix = "Lobby" }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4 bg-white dark:bg-slate-800/50 px-3 py-2 sm:px-4 rounded-lg border border-gray-200 dark:border-slate-600">
      <label className="flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-200 font-medium">
        <input 
          type="radio" 
          name={`diceMode${nameSuffix}`}
          className="w-4 h-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-slate-500"
          checked={diceMode === 'digital'} 
          onChange={() => setDiceMode('digital')} 
        />
        Digital Dice
      </label>
      <label className="flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-200 font-medium">
        <input 
          type="radio" 
          name={`diceMode${nameSuffix}`}
          className="w-4 h-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-slate-500"
          checked={diceMode === 'physical'} 
          onChange={() => setDiceMode('physical')} 
        />
        Physical Dice
      </label>
    </div>
  );
}

export function AdvancedOptionsToggle({ showAdvanced, setShowAdvanced }) {
  return (
    <button 
      className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800/50 hover:bg-gray-50 dark:hover:bg-slate-800 px-4 py-2 rounded-lg font-medium transition-colors border border-gray-200 dark:border-slate-600" 
      onClick={() => setShowAdvanced(!showAdvanced)}
    >
      <Settings size={18} /> {showAdvanced ? "Hide" : "Show"} Advanced Options
    </button>
  );
}

export function AdvancedOptionsPanel({ 
  showAdvanced, 
  game, 
  isOnline = false 
}) {
  const updateCardCount = (card, count) => {
    if (game.setInitialCards) {
      game.setInitialCards(prev => ({ ...prev, [card]: parseInt(count) || 0 }));
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
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">Winning Score</label>
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
                    <label className="text-sm font-medium text-gray-600 dark:text-gray-300">Turn Timer (s)</label>
                    <input 
                      type="number" 
                      className="bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" 
                      value={game.turnDuration} 
                      onChange={(e) => game.setTurnDuration(parseInt(e.target.value) || 0)} 
                      placeholder="0 to disable" 
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-600 dark:text-gray-300">Kick Timer (s) <span className="text-[10px] italic opacity-70 ml-1">(disconnect)</span></label>
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
                <input 
                  type="checkbox" 
                  id={isOnline ? "onlineRandomOrder" : "localRandomOrder"} 
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 flex-shrink-0"
                  checked={game.randomOrder ?? true} 
                  onChange={(e) => game.setRandomOrder(e.target.checked)} 
                />
                <label htmlFor={isOnline ? "onlineRandomOrder" : "localRandomOrder"} className="font-medium text-sm sm:text-base text-gray-700 dark:text-gray-200 cursor-pointer">Random Order</label>
              </div>
            </div>

            <h4 className="font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-slate-600 pb-2 mb-4">Cards in Deck</h4>
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

export function StartGameButton({ startGame, playersCount }) {
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
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="bg-emerald-500 hover:bg-emerald-600 text-white w-full py-4 rounded-xl text-xl font-bold flex justify-center items-center gap-3 shadow-lg shadow-emerald-500/30 transition-colors" 
            onClick={startGame}
          >
            <Play size={24} /> Start Game!
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
