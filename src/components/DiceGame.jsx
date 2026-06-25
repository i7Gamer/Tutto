import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Dices, Check, X, Hand, RotateCw } from 'lucide-react';
import { playBuzzer, playSuccess, playTone } from '../utils/soundEffects';
import confetti from 'canvas-confetti';
import { rollDie, isBust, checkValidityAndScore, applyTuttoBonus } from '../utils/diceLogic';
import { isTestEnv } from '../utils/env';
import { motion, AnimatePresence } from 'framer-motion';

export default function DiceGame({ currentCard, onComplete, onCancel }) {
  const { t } = useTranslation();
  const [keptDice, setKeptDice] = useState([]);
  const [currentRoll, setCurrentRoll] = useState([]);
  const [displayRoll, setDisplayRoll] = useState([]);
  const [rollingDiceIndices, setRollingDiceIndices] = useState(new Set());
  const [turnScore, setTurnScore] = useState(0);
  const [kniffelProgress, setKniffelProgress] = useState([]);
  const [isRolling, setIsRolling] = useState(false);
  
  const [hasRolled, setHasRolled] = useState(false);
  const [bustState, setBustState] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryData, setSummaryData] = useState({ won: false, score: 0, isTutto: false });
  const [tuttosThisTurn, setTuttosThisTurn] = useState(0);
  const [bustCountdown, setBustCountdown] = useState(null);
  const bustTimerStarted = useRef(false);
  
  const selectedRolls = currentRoll.filter(d => d.selected);
  const selectedVals = selectedRolls.map(d => d.val);
  
  const validation = useMemo(() => checkValidityAndScore(selectedVals, currentCard, kniffelProgress), [selectedVals, currentCard, kniffelProgress]);
  
  
  const roll = (numDice, kniffelArray = null, scoreSoFar = 0) => {
    setIsRolling(true);
    setBustState(false);
    
    playTone(600, "sine", 0.1);
    
    const newRollVals = Array.from({length: numDice}, () => rollDie());
    const finalRolls = newRollVals.map((val) => ({ id: crypto.randomUUID(), val, selected: false }));
    
    setCurrentRoll(finalRolls);
    setDisplayRoll(finalRolls.map(r => ({ ...r, val: rollDie() })));
    setHasRolled(true);

    const initialRolling = new Set(finalRolls.map(r => r.id));
    setRollingDiceIndices(initialRolling);
    
    const isTest = isTestEnv();
    const baseTumbleTime = isTest ? 0 : 400;
    const staggerDelay = isTest ? 0 : 150;
    
    finalRolls.forEach((r, idx) => {
      if (isTest) {
        setRollingDiceIndices(prev => {
          const next = new Set(prev);
          next.delete(r.id);
          return next;
        });
        setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
      } else {
        setTimeout(() => {
          setRollingDiceIndices(prev => {
            const next = new Set(prev);
            next.delete(r.id);
            return next;
          });
          setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
          playTone(400 + (idx * 50), "sine", 0.05);
        }, baseTumbleTime + (idx * staggerDelay));
      }
    });

    const totalAnimationTime = baseTumbleTime + ((finalRolls.length - 1) * staggerDelay);

    const finalizeRoll = () => {
      setIsRolling(false);
      
      if (isBust(newRollVals, currentCard, kniffelArray || kniffelProgress)) {
        setBustState(true);
        playBuzzer();
        
        if (currentCard === "Kleeblatt") {
          setShowSummary(true);
          setSummaryData({ won: false, score: 0 });
        } else {
          if (isTest) {
            if (currentCard === "Feuerwerk") {
              setSummaryData({ won: scoreSoFar > 0, score: scoreSoFar, isTutto: false });
            } else {
              setSummaryData({ won: false, score: 0, isTutto: false });
            }
            setShowSummary(true);
          } else {
            setTimeout(() => {
              if (currentCard === "Feuerwerk") {
                setSummaryData({ won: scoreSoFar > 0, score: scoreSoFar, isTutto: false });
              } else {
                setSummaryData({ won: false, score: 0, isTutto: false });
              }
              setShowSummary(true);
            }, 1500);
          }
        }
      }
    };

    if (isTest) {
      finalizeRoll();
    } else {
      setTimeout(finalizeRoll, totalAnimationTime + 100);
    }
  };

  useEffect(() => {
    if (rollingDiceIndices.size === 0) return;
    if (isTestEnv()) return;
    
    const interval = setInterval(() => {
      setDisplayRoll(prev => prev.map(d => 
        rollingDiceIndices.has(d.id) ? { ...d, val: Math.floor(Math.random() * 6) + 1 } : d
      ));
    }, 80);
    
    return () => clearInterval(interval);
  }, [rollingDiceIndices]);

  const handleAction = (action) => {
    if (!validation.valid && action !== 'stop') return;
    
    let newTurnScore = turnScore + validation.score;
    let newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];
    
    const isTutto = newKeptDice.length === 6;
    
    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore, currentCard);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();
      
      if (currentCard === "Kleeblatt") {
        if (tuttosThisTurn === 0) {
          setTuttosThisTurn(1);
          setKeptDice([]);
          setTurnScore(newTurnScore);
          setKniffelProgress(newKniffelProgress);
          roll(6, newKniffelProgress, newTurnScore);
          return;
        } else {
          setSummaryData({ won: true, score: newTurnScore, isTutto: true });
          setShowSummary(true);
          return;
        }
      } else if (currentCard !== "Feuerwerk") {
        setSummaryData({ won: true, score: newTurnScore, isTutto: true });
        setShowSummary(true);
        return;
      }
    }
    
    if (action === 'stop') {
      setSummaryData({ won: true, score: newTurnScore, isTutto });
      setShowSummary(true);
      return;
    }
    
    if (action === 'roll') {
      setTurnScore(newTurnScore);
      setKniffelProgress(newKniffelProgress);
      
      if (isTutto) {
        setKeptDice([]);
        roll(6, newKniffelProgress, newTurnScore);
      } else {
        setKeptDice(newKeptDice);
        roll(6 - newKeptDice.length, newKniffelProgress, newTurnScore);
      }
    }
  };

  const toggleDie = (id) => {
    if (bustState || showSummary || isRolling) return;
    setCurrentRoll(prev => prev.map(d => d.id === id ? { ...d, selected: !d.selected } : d));
  };

  const summaryDataRef = useRef(summaryData);
  useEffect(() => { summaryDataRef.current = summaryData; }, [summaryData]);

  const finishGame = useCallback(() => {
    onComplete(summaryDataRef.current.score || 0, summaryDataRef.current.won || false);
  }, [onComplete]);

  // Auto-continue on a true bust (won = false). Starts exactly once when
  // showSummary && bustState flip to true together, guarded by a ref so that
  // subsequent re-renders caused by setBustCountdown don't re-run the timer.
  useEffect(() => {
    if (!showSummary || !bustState || summaryDataRef.current.won) return;
    if (bustTimerStarted.current) return;   // already running — don't restart
    bustTimerStarted.current = true;

    const AUTO_CONTINUE_MS = isTestEnv() ? 0 : 3000;
    setBustCountdown(isTestEnv() ? 0 : 3);

    const timeout = setTimeout(() => {
      setBustCountdown(null);
      finishGame();
    }, AUTO_CONTINUE_MS);

    return () => clearTimeout(timeout);
  }, [showSummary, bustState, finishGame]);

  // Countdown tick: decrements once per second while bustCountdown > 0.
  // Runs independently of the main timer so re-renders don't kill the timeout.
  useEffect(() => {
    if (bustCountdown === null || bustCountdown <= 0 || isTestEnv()) return;
    const id = setTimeout(() => {
      setBustCountdown(prev => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
    return () => clearTimeout(id);
  }, [bustCountdown]);

  const isMakingTutto = keptDice.length + selectedRolls.length === 6;
  const isSpecialCard = ["Kniffel", "Plus_Minus", "Kleeblatt"].includes(currentCard);
  
  const canStop = hasRolled && !isRolling && !bustState && validation.valid && currentCard !== "Feuerwerk" &&
    (isMakingTutto || !isSpecialCard);

  const isRollAgainApplicable = !(isMakingTutto && currentCard !== "Feuerwerk");
  
  let stopButtonText = t('dice.stop_and_score', "Stop & Score");
  if (isMakingTutto && isSpecialCard) {
    if (currentCard === "Kleeblatt" && tuttosThisTurn === 0) {
      stopButtonText = t('dice.roll_2nd_tutto', "Roll 2nd Tutto");
    } else {
      stopButtonText = t('dice.finish_card', "Finish Card");
    }
  }

  let displayKeptDice = [...keptDice];
  if (currentCard === "Kniffel" && kniffelProgress.length > 0) {
    if (kniffelProgress[0] === 1) {
      displayKeptDice.sort((a, b) => a.val - b.val);
    } else {
      displayKeptDice.sort((a, b) => b.val - a.val);
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800/95 backdrop-blur-xl border border-white/40 shadow-2xl overflow-hidden rounded-3xl flex flex-col items-center">
      {!showSummary && (
        <div className="w-full bg-black/5 dark:bg-white/5 border-b border-gray-200 dark:border-slate-600 p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 m-0">{t('dice.title', 'Dice Game')}</h2>
          {!hasRolled && (
            <button 
              className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors" 
              onClick={onCancel}
              aria-label="Cancel dice roll"
            >
              <X size={20}/>
            </button>
          )}
        </div>
      )}

      <div className="p-8 w-full">
        {showSummary ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-10"
          >
            <h2 className={`text-4xl font-extrabold mb-4 ${summaryData.won ? 'text-emerald-500' : 'text-red-500'}`}>
              {summaryData.won ? t('dice.success', "Success!") : t('dice.bust', "Bust!")}
            </h2>
            {summaryData.isTutto && <h3 className="text-3xl font-bold text-indigo-500 mb-4 animate-bounce">{t('dice.tutto', 'Tutto!')}</h3>}
            {(summaryData.won || currentCard === "Feuerwerk") && !["Kniffel", "Plus_Minus", "Kleeblatt"].includes(currentCard) && summaryData.score > 0 && (
              <p className="text-2xl text-gray-700 dark:text-gray-200">{t('dice.points_gained', 'Points gained: ')}<strong className="text-indigo-600 font-black">{summaryData.score}</strong></p>
            )}
            
            {bustState && !summaryData.won ? (
              <div className="mt-10 flex flex-col items-center gap-3">
                <p className="text-red-400 font-semibold text-lg">
                  {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: bustCountdown ?? 0 })}
                </p>
                <div className="w-full bg-red-100 dark:bg-red-900/30 rounded-full h-2 overflow-hidden">
                  <motion.div
                    className="h-2 bg-red-500 rounded-full"
                    initial={{ width: '100%' }}
                    animate={{ width: '0%' }}
                    transition={{ duration: isTestEnv() ? 0 : 3, ease: 'linear' }}
                  />
                </div>
              </div>
            ) : (
              <button 
                className="mt-10 bg-indigo-600 hover:bg-indigo-700 text-white w-full py-4 rounded-xl text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/30 transition-all" 
                onClick={finishGame}
              >
                {t('dice.continue', 'Continue to Next Player')} <Check size={24} />
              </button>
            )}
          </motion.div>
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">{t('dice.current_score', 'Current Score')}</div>
              <motion.div 
                key={turnScore + (validation.valid ? validation.score : 0)}
                initial={{ scale: 1.2 }}
                animate={{ scale: 1 }}
                className="text-5xl font-black text-indigo-600 dark:text-indigo-400"
              >
                {turnScore + (validation.valid ? validation.score : 0)}
              </motion.div>
              {currentCard === "Kleeblatt" && (
                <div className="text-emerald-500 mt-2 font-bold text-lg bg-emerald-50 inline-block px-4 py-1 rounded-full border border-emerald-200">
                  {t('dice.tuttos_count', 'Tuttos: {{count}} / 2', { count: tuttosThisTurn })}
                </div>
              )}
            </div>

            <div className="mb-6">
              <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('dice.kept_dice', 'Kept Dice')}</h4>
              <div className="min-h-[80px] p-4 bg-black/5 dark:bg-white/5 rounded-2xl flex gap-3 flex-wrap items-center border border-gray-200 dark:border-slate-600/50 shadow-inner">
                <AnimatePresence>
                  {displayKeptDice.map((d, i) => (
                    <motion.div 
                      key={`kept-${i}`} 
                      initial={{ scale: 0, rotate: -180 }}
                      animate={{ scale: 1, rotate: 0 }}
                      className="die w-14 h-14 bg-indigo-600 text-white rounded-xl shadow-md flex items-center justify-center text-2xl font-bold border-2 border-indigo-400"
                    >
                      {d.val}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {displayKeptDice.length === 0 && <span className="text-gray-400 font-medium italic mx-auto">{t('dice.none', 'None')}</span>}
              </div>
            </div>

            <div className="mb-8">
              <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('dice.current_roll', 'Current Roll')}</h4>
              {!hasRolled ? (
                <div className="py-8 text-center flex justify-center">
                  <motion.button 
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-2xl text-xl font-bold flex items-center gap-3 shadow-lg shadow-indigo-500/30 transition-all" 
                    onClick={() => roll(6)}
                  >
                    <Dices size={28} /> {t('dice.roll_6_dice', 'Roll 6 Dice')}
                  </motion.button>
                </div>
              ) : (
                <>
                  <div className="min-h-[80px] p-4 bg-white dark:bg-slate-800 rounded-2xl flex gap-3 flex-wrap justify-center border border-gray-200 dark:border-slate-600 shadow-sm">
                    {displayRoll.map(d => {
                      const isDieTumbling = rollingDiceIndices.has(d.id);
                      const actualDie = currentRoll.find(cr => cr.id === d.id);
                      const isSelected = actualDie?.selected || false;
                      
                      return (
                        <motion.button 
                          key={d.id} 
                          layout
                          animate={{ 
                            rotate: isDieTumbling ? [0, 90, 180, 270, 360] : 0,
                            y: isDieTumbling ? [0, -20, 0] : 0 
                          }}
                          transition={{ 
                            rotate: { repeat: isDieTumbling ? Infinity : 0, duration: 0.2 },
                            y: { repeat: isDieTumbling ? Infinity : 0, duration: 0.15 }
                          }}
                          className={`die w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-bold transition-all border-2
                            ${isSelected 
                              ? 'bg-emerald-100 border-emerald-500 text-emerald-700 shadow-[0_0_15px_rgba(16,185,129,0.3)] scale-110 z-10' 
                              : bustState 
                                ? 'bg-red-50 border-red-300 text-red-500 opacity-70 cursor-default' 
                                : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-500 text-gray-800 dark:text-gray-100 shadow-sm ' + (isDieTumbling ? '' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50')
                            }
                          `}
                          onClick={() => toggleDie(d.id)}
                          disabled={bustState || isDieTumbling}
                          aria-pressed={isSelected}
                          aria-label={`Die showing ${d.val}, ${isSelected ? 'selected' : 'not selected'}`}
                        >
                          {d.val}
                        </motion.button>
                      );
                    })}
                  </div>
                  
                  {bustState && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-center text-red-500 text-2xl font-black mt-6 bg-red-50 py-3 rounded-xl border border-red-100"
                    >
                      {t('dice.bust_description', 'Bust! (Volltreffer/Niete)')}
                    </motion.div>
                  )}
                  
                  {!bustState && (
                    <div className="text-center mt-3 min-h-[24px]">
                      {!validation.valid && selectedRolls.length > 0 && (
                        <span className="text-red-500 font-bold bg-red-50 px-3 py-1 rounded-full border border-red-100">{t('dice.invalid_selection', 'Invalid selection')}</span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <AnimatePresence>
              {hasRolled && !bustState && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col sm:flex-row gap-4 justify-center mt-8 pt-6 border-t border-gray-100 dark:border-slate-700"
                >
                  {canStop && (
                    <button 
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`} 
                      disabled={!validation.valid} 
                      onClick={() => handleAction('stop')}
                    >
                      <Hand size={20} /> {stopButtonText}
                    </button>
                  )}
                  
                  {isRollAgainApplicable && (
                    <button 
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`} 
                      disabled={!validation.valid}
                      onClick={() => handleAction('roll')}
                    >
                      <RotateCw size={20} /> {t('dice.roll_again', 'Roll Again')}
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}
