import React, { useState } from 'react';
import { UserPlus, Trash2, Settings, Play, ChevronUp, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DiceModeSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton } from './LobbyShared';

export default function LocalLobby({ game }) {
  const [newPlayerName, setNewPlayerName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { players, addPlayer, removePlayer, startGame, winningScore, setWinningScore, initialCards, setInitialCards, reorderPlayers, randomOrder, setRandomOrder, changePlayerColor } = game;

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (trimmedName === "") return;
    
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      alert("A player with this name already exists!");
      return;
    }
    
    addPlayer(trimmedName);
    setNewPlayerName("");
  };

  const updateCardCount = (card, count) => {
    setInitialCards(prev => ({ ...prev, [card]: parseInt(count) || 0 }));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newPlayers = [...players];
    [newPlayers[index - 1], newPlayers[index]] = [newPlayers[index], newPlayers[index - 1]];
    reorderPlayers(newPlayers);
  };

  const handleMoveDown = (index) => {
    if (index === players.length - 1) return;
    const newPlayers = [...players];
    [newPlayers[index + 1], newPlayers[index]] = [newPlayers[index], newPlayers[index + 1]];
    reorderPlayers(newPlayers);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <div className="mb-8">
        <h3 className="text-xl font-bold mb-4">Players</h3>
        <div className="flex items-center gap-3 mb-6">
          <input 
            type="text" 
            placeholder="Name of new player" 
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
            <UserPlus size={18} /> Add
          </motion.button>
        </div>

        <AnimatePresence>
          {players && players.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }} 
              animate={{ opacity: 1, height: 'auto' }} 
              exit={{ opacity: 0, height: 0 }}
              className="bg-white dark:bg-slate-800/40 rounded-xl overflow-hidden mb-6 border border-gray-100 dark:border-slate-700"
            >
              <table className="w-full text-left border-collapse">
                <tbody>
                  <AnimatePresence>
                    {players.map((p, idx) => (
                      <motion.tr 
                        key={p.name}
                        layout
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-white dark:bg-slate-800/50 transition-colors"
                      >
                        <td className="p-3 font-semibold" style={{ color: p.color || '#1f2937' }}>
                          <input 
                            type="color" 
                            value={p.color || '#ffffff'} 
                            onChange={(e) => changePlayerColor(p.name, e.target.value)}
                            className="w-6 h-6 p-0 border-0 bg-transparent align-middle mr-3 cursor-pointer"
                          />
                          {p.name}
                        </td>
                        <td className="p-3 whitespace-nowrap w-36">
                          <div className="flex items-center justify-end gap-1">
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
                            <div className="w-8 h-8 flex items-center justify-center ml-1">
                              <button className="text-red-500 hover:bg-red-100 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => removePlayer(p.name)}>
                                <Trash2 size={18} />
                              </button>
                            </div>
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-col justify-center items-center gap-4 mb-8">
        <DiceModeSelector 
          diceMode={game.diceMode} 
          setDiceMode={game.setDiceMode} 
          nameSuffix="Local" 
        />
        <AdvancedOptionsToggle 
          showAdvanced={showAdvanced} 
          setShowAdvanced={setShowAdvanced} 
        />
      </div>

      <AdvancedOptionsPanel 
        showAdvanced={showAdvanced} 
        game={game} 
        isOnline={false} 
        setWinningScore={setWinningScore} 
        setRandomOrder={setRandomOrder} 
        updateCardCount={updateCardCount} 
      />

      <StartGameButton 
        startGame={startGame} 
        playersCount={players ? players.length : 0} 
      />
    </motion.div>
  );
}
