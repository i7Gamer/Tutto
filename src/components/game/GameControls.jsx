import React from 'react';
import { Undo2, ChevronRight, Check, X, Dices } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function GameControls({ 
  currentCard, 
  isMyTurn, 
  diceMode, 
  setShowDiceGame, 
  scoreInput, 
  setScoreInput, 
  applyBonus, 
  setApplyBonus, 
  handleNextTurn, 
  handleYesNo, 
  undo, 
  endGame,
  isOnline,
  isHost,
  leaveRoom
}) {
  const currentCardHasInput = !["Stop", "Plus_Minus", "Kniffel", "Kleeblatt"].includes(currentCard);
  const currentCardHasYesNo = ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(currentCard);
  const isStopCard = currentCard === "Stop";

  const addScore = (val) => {
    setScoreInput(prev => {
      const current = parseInt(prev) || 0;
      return (current + val).toString();
    });
  };

  return (
    <div className="flex flex-col items-center bg-[var(--card-bg)] backdrop-blur border border-white/40 dark:border-slate-700 rounded-3xl p-6 shadow-xl relative overflow-hidden">
      <AnimatePresence mode="wait">
        {isMyTurn && !isStopCard && (
          <motion.div 
            key="input-controls"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="w-full flex flex-col items-center"
          >
            {diceMode === 'digital' && (
              <>
                <motion.button 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-indigo-500/30 transition-colors mb-4" 
                  onClick={() => setShowDiceGame(true)}
                >
                  <Dices className="w-5 h-5 md:w-6 md:h-6" /> Roll Dice
                </motion.button>
              </>
            )}

            {currentCardHasInput && (
              <>
                {diceMode === 'physical' && (
                  <>
                    <div className="flex flex-row items-center gap-3 mb-4 md:mb-6 w-full max-w-sm">
                      <input 
                        type="number" 
                        value={scoreInput}
                        onChange={(e) => setScoreInput(e.target.value)}
                        placeholder="Score"
                        className="flex-1 min-w-0 w-full text-center text-2xl md:text-3xl font-bold py-3 md:py-4 rounded-2xl border-2 border-gray-200 dark:border-slate-600 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 bg-[var(--card-bg)] transition-all outline-none"
                      />
                      {["200", "300", "400", "500", "600", "x2"].includes(currentCard) && (
                        <label className="flex flex-col items-center justify-center gap-1 cursor-pointer bg-amber-50 text-amber-800 px-3 py-2 md:py-3 rounded-2xl border border-amber-200 font-semibold hover:bg-amber-100 transition-colors h-full">
                          <input 
                            type="checkbox" 
                            checked={applyBonus} 
                            onChange={(e) => setApplyBonus(e.target.checked)} 
                            className="w-5 h-5 rounded text-amber-600 focus:ring-amber-500 border-amber-300"
                          />
                          <span className="text-xs md:text-sm whitespace-nowrap">Apply bonus</span>
                        </label>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-2 mb-6 w-full max-w-sm">
                      {[50, 100, 200, 300, 400, 500, 600, 1000].map(val => (
                        <motion.button 
                          key={val} 
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          className="bg-[var(--card-bg)] hover:bg-indigo-50 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-white font-bold py-1.5 md:py-2 text-sm md:text-base rounded-lg md:rounded-xl border border-indigo-100 dark:border-indigo-800 transition-colors shadow-sm" 
                          onClick={() => addScore(val)}
                        >
                          +{val}
                        </motion.button>
                      ))}
                    </div>

                    <motion.button 
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-emerald-500/30 transition-colors" 
                      onClick={handleNextTurn}
                    >
                      Next Turn <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
                    </motion.button>
                  </>
                )}
              </>
            )}

            {currentCardHasYesNo && diceMode === 'physical' && (
              <div className={`w-full mt-4 border-t border-gray-100 dark:border-slate-700 pt-6`}>
                <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 text-center">Did you succeed?</h4>
                <div className="flex gap-4 w-full max-w-sm mx-auto">
                  <motion.button 
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-emerald-500/30 transition-colors" 
                    onClick={() => handleYesNo(true)}
                  >
                    <Check className="w-5 h-5 md:w-6 md:h-6" /> Yes
                  </motion.button>
                  <motion.button 
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-red-500/30 transition-colors" 
                    onClick={() => handleYesNo(false)}
                  >
                    <X className="w-5 h-5 md:w-6 md:h-6" /> No
                  </motion.button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {isMyTurn && isStopCard && (
          <motion.div 
            key="stop-controls"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex flex-col items-center justify-center p-8 text-center"
          >
            <h4 className="text-2xl font-bold text-red-500 mb-6">Stop! Your turn is over.</h4>
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="bg-red-500 hover:bg-red-600 text-white w-full max-w-sm py-4 rounded-2xl text-xl font-bold flex justify-center items-center gap-3 shadow-lg shadow-red-500/30 transition-colors" 
              onClick={() => handleYesNo(false)}
            >
              Continue <ChevronRight size={24} />
            </motion.button>
          </motion.div>
        )}

        {!isMyTurn && (
          <motion.div 
            key="waiting-controls"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center p-8 text-center"
          >
            <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin mb-4"></div>
            <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100">Waiting for other player...</h4>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex justify-between w-full mt-8 pt-6 border-t border-gray-100 dark:border-slate-700">
        {(!isOnline || isHost) ? (
          <button 
            className="flex items-center gap-2 text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg font-medium transition-colors" 
            onClick={() => {
              if (window.confirm("Do you really want to end the game?")) endGame();
            }}
          >
            <X size={18} /> End Game
          </button>
        ) : (
          <button 
            className="flex items-center gap-2 text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg font-medium transition-colors" 
            onClick={() => {
              if (window.confirm("Do you really want to leave the game?")) leaveRoom();
            }}
          >
            <X size={18} /> Leave Game
          </button>
        )}
        <button 
          className="flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:bg-white/5 hover:text-gray-800 dark:text-gray-100 px-4 py-2 rounded-lg font-medium transition-colors" 
          onClick={undo}
        >
          <Undo2 size={18} /> Undo
        </button>
      </div>
    </div>
  );
}
