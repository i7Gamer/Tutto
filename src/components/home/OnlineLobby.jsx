import React, { useState } from 'react';
import { Copy, UserMinus, Crown, Play, Loader2, WifiOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DiceModeSelector, AdvancedOptionsToggle, AdvancedOptionsPanel, StartGameButton } from './LobbyShared';

export default function OnlineLobby({ game }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inputRoomCode, setInputRoomCode] = useState(() => localStorage.getItem('tutto_last_room') || "");
  const [inputName, setInputName] = useState(() => localStorage.getItem('tutto_last_name') || "");
  const [errorMsg, setErrorMsg] = useState("");

  const { players, startGame, winningScore, setWinningScore, initialCards, setInitialCards, reorderPlayers, randomOrder, setRandomOrder, changeMyColor, isHost, hostId, joinRoom, leaveRoom, roomId, myName, kickPlayer } = game;

  const handleJoin = async () => {
    if (!inputRoomCode || !inputName) {
      setErrorMsg("Please enter both a Room Code and a Name.");
      return;
    }
    setErrorMsg("");
    const res = await joinRoom(inputRoomCode, inputName);
    if (res && res.error) {
      setErrorMsg(res.error);
    } else {
      localStorage.setItem('tutto_last_room', inputRoomCode);
      localStorage.setItem('tutto_last_name', inputName);
    }
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

  if (!roomId) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 max-w-sm mx-auto">
        <h3 className="text-xl font-bold mb-4 text-center">Join or Create Room</h3>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Room Code</label>
            <input 
              type="text" 
              value={inputRoomCode} 
              onChange={(e) => setInputRoomCode(e.target.value)} 
              placeholder="e.g. 1234" 
              className="bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Your Name</label>
            <input 
              type="text" 
              value={inputName} 
              onChange={(e) => setInputName(e.target.value)} 
              placeholder="e.g. Alice" 
              className="bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {errorMsg && <div className="text-red-500 text-sm font-medium bg-red-50 p-2 rounded">{errorMsg}</div>}
          <motion.button 
            whileHover={{ scale: 1.05 }} 
            whileTap={{ scale: 0.95 }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl mt-2 shadow-lg shadow-indigo-500/30 transition-all" 
            onClick={handleJoin}
          >
            Join / Create
          </motion.button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-2xl font-bold text-indigo-900">Room: {roomId}</h3>
          <button 
            className="text-red-500 hover:bg-red-50 border border-red-200 px-4 py-2 rounded-lg font-medium transition-colors" 
            onClick={() => {
              if (window.confirm("Do you really want to leave the room?")) leaveRoom();
            }}
          >
            Leave Room
          </button>
        </div>
        <p className="mb-6 text-gray-700 dark:text-gray-200 text-lg">You are: <strong className="text-indigo-600">{myName}</strong> {isHost ? <span className="text-amber-500 font-medium">(Host)</span> : ""}</p>
        
        <h4 className="font-bold text-gray-800 dark:text-gray-100 mb-3">Players in Lobby:</h4>
        <div className="bg-white dark:bg-slate-800/40 rounded-xl overflow-hidden mb-6 border border-gray-100 dark:border-slate-700">
          <table className="w-full text-left border-collapse">
            <tbody>
              <AnimatePresence>
                {players && players.map((p, idx) => (
                  <motion.tr 
                    key={p.name}
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className={`border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-white dark:bg-slate-800/50 transition-colors ${p.name === myName ? 'bg-indigo-50/50' : ''}`}
                  >
                    <td className="p-3 font-semibold flex items-center gap-2" style={{ color: p.color || '#1f2937' }}>
                      {p.name === myName ? (
                        <input 
                          type="color" 
                          value={p.color || '#ffffff'} 
                          onChange={(e) => changeMyColor(e.target.value)}
                          className="w-6 h-6 p-0 border-0 bg-transparent align-middle cursor-pointer"
                        />
                      ) : (
                        <span className="inline-block w-4 h-4 rounded-full shadow-sm border border-black/10" style={{ backgroundColor: p.color || '#ffffff' }}></span>
                      )}
                      {p.name} 
                      {p.socketId === hostId && <Crown size={16} className="text-amber-500" />}
                    </td>
                    {isHost && (
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
                            {p.socketId !== hostId && (
                              <button className="text-red-500 hover:bg-red-100 w-full h-full flex items-center justify-center rounded transition-colors" onClick={() => kickPlayer(p.socketId)}>
                                <UserMinus size={18} />
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    )}
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        <div className="flex flex-col justify-center items-center gap-4 mb-8">
          <DiceModeSelector 
            diceMode={game.diceMode} 
            setDiceMode={game.setDiceMode} 
            nameSuffix="Online" 
          />

          {isHost && (
            <AdvancedOptionsToggle 
              showAdvanced={showAdvanced} 
              setShowAdvanced={setShowAdvanced} 
            />
          )}
        </div>

        {isHost && (
          <AdvancedOptionsPanel 
            showAdvanced={showAdvanced} 
            game={game} 
            isOnline={true} 
            setWinningScore={setWinningScore} 
            setRandomOrder={setRandomOrder} 
            updateCardCount={updateCardCount} 
          />
        )}

        <AnimatePresence>
          {isHost ? (
            <StartGameButton 
              startGame={startGame} 
              playersCount={players ? players.length : 0} 
            />
          ) : (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center text-indigo-600 font-bold text-lg p-6 bg-white dark:bg-slate-800/40 rounded-xl border border-indigo-100"
            >
              <div className="flex justify-center mb-3">
                <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
              </div>
              Waiting for host to start the game...
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
