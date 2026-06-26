import { useState, useEffect, useRef, useCallback } from 'react';
import { useGameStore } from '../store/useGameStore';
import confetti from 'canvas-confetti';
import { playBuzzer, playSuccess } from '../utils/soundEffects';
import { isTestEnv } from '../utils/env';
import { computeRankedPlayers } from '../utils/coreGameEngine';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../utils/formatTime';

import Scoreboard from './game/Scoreboard';
import CardDisplay from './game/CardDisplay';
import GameControls from './game/GameControls';
import DiceGame from './DiceGame';

export default function Game() {
  const { t } = useTranslation();
  const game = useGameStore();
  const {
    currentCard,
    cards,
    nextTurn,
    undo,
    endGame,
    isOnline,
    myName,
    winningScore,
    players,
    currentPlayerIndex,
    gameTimeInSeconds,
    liveTurnState,
    setLiveTurnState,
    diceMode,
    isHost,
    kickPlayer,
    justReconnected,
  } = game;

  const formattedTime = formatTime(gameTimeInSeconds);

  const currentPlayer = currentPlayerIndex !== null ? players[currentPlayerIndex] : null;
  const sortedPlayers = computeRankedPlayers(players);

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  const [scoreInput, setScoreInput] = useState("");
  const [applyBonus, setApplyBonus] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);
  const confettiFiredRef = useRef(false);

  useEffect(() => {
    if (!isMyTurn) {
      setShowDiceGame(false);
    }
  }, [isMyTurn]);

  // Auto-open DiceGame on reconnect if turn was in progress
  useEffect(() => {
    if (justReconnected && liveTurnState && isMyTurn && diceMode === 'digital') {
      game.addToast("Resuming your dice game...");
      const timer = setTimeout(() => {
        setShowDiceGame(true);
        // Reset the flag after opening
        useGameStore.setState({ justReconnected: false });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [justReconnected, liveTurnState, isMyTurn, diceMode]);

  useEffect(() => {
    let soundTimeout;
    let turnTimeout;

    if (currentCard === "Stop") {
      if (isTestEnv()) {
        playBuzzer();
        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(() => nextTurn(0, false), 5000);
        }
      } else {
        soundTimeout = setTimeout(() => {
          playBuzzer();
        }, 1200); // Wait for card to visually flip and settle (matches GameControls UI delay)

        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(() => nextTurn(0, false), 6200);
        }
      }
    }
    
    return () => {
      clearTimeout(soundTimeout);
      clearTimeout(turnTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, isMyTurn, currentCard, cards?.length]);

  useEffect(() => {
    confettiFiredRef.current = false;
  }, [currentCard, cards?.length]);

  useEffect(() => {
    let timeout;
    if (currentCard === "Feuerwerk" && !confettiFiredRef.current) {
      if (isTestEnv()) {
        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
        playSuccess();
        confettiFiredRef.current = true;
      } else {
        timeout = setTimeout(() => {
          if (!confettiFiredRef.current) {
            confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
            playSuccess();
            confettiFiredRef.current = true;
          }
        }, 1200); // Wait for card to visually flip and settle (matches GameControls UI delay)
      }
    }
    return () => clearTimeout(timeout);
  }, [currentCard, cards?.length]);

  const handleNextTurn = () => {
    let parsedScore = Math.max(0, parseInt(scoreInput) || 0);
    
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

  const handleDiceComplete = useCallback((score, isSuccess) => {
    setShowDiceGame(false);
    nextTurn(score, isSuccess);
  }, [nextTurn]);

  const handleCancelDiceGame = useCallback(() => {
    setShowDiceGame(false);
    localStorage.removeItem('tutto_dice_turn_state');
    if (isOnline) setLiveTurnState(null);
  }, [isOnline, setLiveTurnState]);

  return (
    <div className="container mx-auto px-2 md:px-4 pt-2 md:pt-4 pb-20 max-w-3xl flex flex-col gap-2 md:gap-4">
      <Scoreboard game={game} formattedTime={formattedTime} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
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
            cardsLength={cards?.length || 0}
            isMyTurn={isMyTurn}
            diceMode={diceMode}
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
            isHost={isHost}
            leaveRoom={game.leaveRoom}
            activeTurnState={liveTurnState}
            currentPlayer={currentPlayer}
          />
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:col-span-2 bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-3xl p-6 shadow-xl flex flex-col"
        >
          <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 uppercase tracking-wider text-center">{t('game.leaderboard', 'Leaderboard')}</h3>
          <div className="flex flex-col rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800/40 overflow-hidden">
            <div className="flex px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700 bg-black/5 dark:bg-white/5">
              <div className="w-12">{t('game.pos', 'Pos')}</div>
              <div className="flex-1">{t('game.player', 'Player')}</div>
              <div className="w-24 text-right">{t('game.score', 'Score')}</div>
            </div>
            <div className="flex flex-col">
              {sortedPlayers.map(p => {
                const isCurrent = currentPlayer && p.name === currentPlayer.name;
                return (
                  <motion.div 
                    layout
                    key={p.deviceId || p.name} 
                    className={`flex items-center px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 transition-colors ${isCurrent ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
                  >
                    <div className="w-12 font-medium text-gray-600 dark:text-gray-300">{p.position}.</div>
                    <div className="flex-1 font-bold flex items-center flex-wrap gap-2" style={{ color: p.color || 'var(--text-color, #1f2937)' }}>
                      <span>{p.name}</span>
                      {isOnline && game.hostId === p.socketId && <span title={t('game.host', 'Host')} className="text-lg leading-none">👑</span>}
                      {p.disconnected && (
                        <>
                          <span className="text-red-500 text-[10px] sm:text-xs font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50 whitespace-nowrap">{t('game.disconnected', 'Disconnected')}</span>
                          {isOnline && isHost && (
                            <button
                              onClick={() => kickPlayer(p.socketId)}
                              className="text-red-600 dark:text-red-400 hover:text-white hover:bg-red-500 dark:hover:bg-red-600 px-2 py-0.5 text-[10px] sm:text-xs font-semibold rounded-full border border-red-200 dark:border-red-800 transition-colors shadow-sm ml-1"
                              title={t('game.kickPlayer', 'Kick Player')}
                            >
                              {t('game.kick', 'Kick')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    <div className="w-24 font-bold text-gray-800 dark:text-gray-100 text-right">{p.score}</div>
                  </motion.div>
                );
              })}
            </div>
          </div>
          {winningScore > 0 && (
            <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/5 p-3 rounded-xl border border-gray-100 dark:border-slate-700">
              {t('game.goalPrefix', 'Goal: First to reach')} <strong className="text-indigo-600">{winningScore}</strong> {t('game.goalSuffix', 'points wins!')}
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
              onCancel={handleCancelDiceGame}
              onStateChange={isOnline && diceMode === 'digital' ? setLiveTurnState : undefined}
            />
          </motion.div>
        </div>
      )}
    </div>
  );
}
