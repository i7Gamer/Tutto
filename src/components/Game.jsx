import React, { useState, useEffect } from 'react';
import { useGameStore } from '../store/useGameStore';
import confetti from 'canvas-confetti';
import { playBuzzer, playSuccess } from '../utils/soundEffects';
import { motion } from 'framer-motion';

import Scoreboard from './game/Scoreboard';
import CardDisplay from './game/CardDisplay';
import GameControls from './game/GameControls';
import DiceGame from './DiceGame';

export default function Game() {
  const game = useGameStore();
  const { 
    currentCard, 
    round, 
    cards,
    nextTurn,
    undo,
    endGame,
    isOnline,
    myName,
    winningScore,
    players,
    currentPlayerIndex,
    gameTimeInSeconds
  } = game;

  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  };
  const formattedTime = formatTime(gameTimeInSeconds);

  const currentPlayer = currentPlayerIndex !== null ? players[currentPlayerIndex] : null;
  const sortedPlayers = players.map(p => ({...p})).sort((a, b) => b.score - a.score);
  sortedPlayers.forEach((p, i) => {
    if (i > 0 && p.score === sortedPlayers[i - 1].score) {
      p.position = sortedPlayers[i - 1].position;
    } else {
      p.position = i === 0 ? 1 : sortedPlayers[i - 1].position + 1;
    }
  });

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  const [scoreInput, setScoreInput] = useState("");
  const [applyBonus, setApplyBonus] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);

  useEffect(() => {
    let timeout;
    if (isOnline && isMyTurn && currentCard === "Stop") {
      playBuzzer();
      timeout = setTimeout(() => {
        nextTurn(0, false);
      }, 5000);
    } else if (!isOnline && currentCard === "Stop") {
      playBuzzer();
    }
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, isMyTurn, currentCard]);

  useEffect(() => {
    if (currentCard === "Feuerwerk") {
      confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
      playSuccess();
    }
  }, [currentCard, cards?.length]);

  const handleNextTurn = () => {
    let parsedScore = parseInt(scoreInput) || 0;
    
    if (applyBonus) {
      if (currentCard === "200") parsedScore += 200;
      else if (currentCard === "300") parsedScore += 300;
      else if (currentCard === "400") parsedScore += 400;
      else if (currentCard === "500") parsedScore += 500;
      else if (currentCard === "600") parsedScore += 600;
      else if (currentCard === "x2") parsedScore *= 2;
    }

    nextTurn(parsedScore, parsedScore > 0);
    setScoreInput("");
    setApplyBonus(false);
  };

  const handleYesNo = (isSuccess) => {
    nextTurn(0, isSuccess);
  };

  const handleDiceComplete = (score, isSuccess) => {
    setShowDiceGame(false);
    nextTurn(score, isSuccess);
  };

  return (
    <div className="container mx-auto px-2 md:px-4 py-3 md:py-8 max-w-3xl flex flex-col gap-2 md:gap-6 pb-20">
      <Scoreboard game={game} formattedTime={formattedTime} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-6">
        <motion.div 
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex flex-col h-full"
        >
          <CardDisplay currentCard={currentCard} cards={cards} />
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex flex-col h-full"
        >
          <GameControls 
            currentCard={currentCard}
            isMyTurn={isMyTurn}
            diceMode={game.diceMode}
            setShowDiceGame={setShowDiceGame}
            scoreInput={scoreInput}
            setScoreInput={setScoreInput}
            applyBonus={applyBonus}
            setApplyBonus={setApplyBonus}
            handleNextTurn={handleNextTurn}
            handleYesNo={handleYesNo}
            undo={undo}
            endGame={endGame}
            isOnline={isOnline}
            isHost={game.isHost}
            leaveRoom={game.leaveRoom}
          />
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:col-span-2 bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-3xl p-6 shadow-xl flex flex-col mt-4"
        >
          <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 uppercase tracking-wider text-center">Leaderboard</h3>
          <div className="overflow-x-auto rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800/40">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-black/5 dark:bg-white/5">
                  <th className="p-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700">Pos</th>
                  <th className="p-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700">Player</th>
                  <th className="p-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {sortedPlayers.map(p => {
                  const isCurrent = currentPlayer && p.name === currentPlayer.name;
                  return (
                    <motion.tr 
                      layout
                      key={p.name} 
                      className={`border-b border-gray-50 last:border-0 transition-colors ${isCurrent ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'hover:bg-white dark:bg-slate-800/50'}`}
                    >
                      <td className="p-3 font-medium text-gray-600 dark:text-gray-300">{p.position}.</td>
                      <td className="p-3 font-bold flex items-center flex-wrap gap-2" style={{ color: p.color || '#1f2937' }}>
                        <span>{p.name}</span>
                        {isOnline && game.hostId === p.socketId && <span title="Host" className="text-lg leading-none">👑</span>}
                        {p.disconnected && <span className="text-red-500 text-[10px] sm:text-xs font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50 whitespace-nowrap">Disconnected</span>}
                      </td>
                      <td className="p-3 font-bold text-gray-800 dark:text-gray-100 text-right">{p.score}</td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {winningScore > 0 && (
            <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/5 p-3 rounded-xl border border-gray-100 dark:border-slate-700">
              Goal: First to reach <strong className="text-indigo-600">{winningScore}</strong> points wins!
            </div>
          )}
        </motion.div>
      </div>



      {showDiceGame && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl"
          >
            <DiceGame 
              currentCard={currentCard} 
              onComplete={handleDiceComplete} 
              onCancel={() => setShowDiceGame(false)} 
            />
          </motion.div>
        </div>
      )}
    </div>
  );
}
