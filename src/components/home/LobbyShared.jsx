import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Play } from 'lucide-react';

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
  isOnline = false, 
  setWinningScore, 
  setRandomOrder, 
  updateCardCount 
}) {
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
                  onChange={(e) => setWinningScore(parseInt(e.target.value) || 0)} 
                />
              </div>
              
              <div className={`flex items-center gap-2 pb-2`}>
                <input 
                  type="checkbox" 
                  id={isOnline ? "onlineRandomOrder" : "localRandomOrder"} 
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 flex-shrink-0"
                  checked={game.randomOrder ?? true} 
                  onChange={(e) => setRandomOrder(e.target.checked)} 
                />
                <label htmlFor={isOnline ? "onlineRandomOrder" : "localRandomOrder"} className="font-medium text-sm sm:text-base text-gray-700 dark:text-gray-200 cursor-pointer">Random Order</label>
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
