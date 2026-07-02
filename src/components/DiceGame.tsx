import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Dices, X, Hand, RotateCw } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { playBuzzer, playSuccess, playTone } from '../utils/soundEffects';
import confetti from 'canvas-confetti';
import { rollDie, isBust, checkValidityAndScore, applyTuttoBonus, getMaxValidSelection } from '../utils/diceLogic';
import { parseSavedDiceState, buildDiceSnapshot } from '../utils/diceTurnState';
import { deriveTurnControls, sortKeptDiceForDisplay } from '../utils/diceTurnControls';
import { useAutoContinueCountdown } from '../hooks/useAutoContinueCountdown';
import { isTestEnv } from '../utils/env';
import { motion, AnimatePresence } from 'framer-motion';
import Die from './game/Die';
import DiceSummary from './game/DiceSummary';
import type { CardType, Die as DieType, DiceSnapshot } from '../types';

interface DiceGameProps {
  currentCard: CardType | null;
  // Identifies the turn this instance was opened for (see buildTurnKey in
  // diceTurnState.ts). Left undefined, restoration is unconditional — matches
  // every test in this file that doesn't pass it and predates this prop.
  turnKey?: string;
  onComplete: (score: number, isSuccess: boolean) => void;
  onCancel: () => void;
  onStateChange?: (snapshot: DiceSnapshot | null) => void;
}

interface SummaryData {
  won: boolean;
  score: number;
  isTutto?: boolean;
}

const CARD_NAME_MAP: Partial<Record<CardType, string>> = {
  'Plus_Minus': 'Plus/Minus',
  '200': '200 Bonus',
  '300': '300 Bonus',
  '400': '400 Bonus',
  '500': '500 Bonus',
  '600': '600 Bonus',
};

export default function DiceGame({ currentCard, turnKey, onComplete, onCancel, onStateChange }: DiceGameProps) {
  const { t } = useTranslation();

  const getDisplayCardName = (cardName: CardType | null): string => {
    if (!cardName) return '';
    return CARD_NAME_MAP[cardName] ?? cardName;
  };

  const initRestoredRef = useRef(false);

  const [keptDice, setKeptDice] = useState<DieType[]>([]);
  const [currentRoll, setCurrentRoll] = useState<DieType[]>([]);
  const [displayRoll, setDisplayRoll] = useState<DieType[]>([]);
  const [rollingDiceIndices, setRollingDiceIndices] = useState<Set<string>>(new Set());
  const [turnScore, setTurnScore] = useState(0);
  const [kniffelProgress, setKniffelProgress] = useState<number[]>([]);
  const [isRolling, setIsRolling] = useState(false);
  const [hasRolled, setHasRolled] = useState(false);
  const [bustState, setBustState] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryData, setSummaryData] = useState<SummaryData>({ won: false, score: 0, isTutto: false });
  const [tuttosThisTurn, setTuttosThisTurn] = useState(0);

  useEffect(() => {
    if (initRestoredRef.current) return;
    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));
    if (restored) {
      // A snapshot stamped for a different turn — e.g. the server's turn timer
      // advanced past this player while they were disconnected/backgrounded, so
      // their own client never got the chance to clear its cache entry — must be
      // discarded rather than resumed into their new turn. turnKey is undefined
      // for callers that don't pass it (predating this prop), in which case
      // restoration stays unconditional as before.
      if (turnKey !== undefined && restored.turnKey !== turnKey) {
        localStorage.removeItem('tutto_dice_turn_state');
        return;
      }

      initRestoredRef.current = true;

      // Restoring saved dice game state from localStorage - intentional one-time initialization
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTurnScore(restored.turnScore);
      setKeptDice(restored.keptDice);
      setCurrentRoll(restored.currentRoll);
      setDisplayRoll(restored.currentRoll);
      setKniffelProgress(restored.kniffelProgress);
      setTuttosThisTurn(restored.tuttosThisTurn);
      setHasRolled(true);
      if (restored.busted) {
        setBustState(true);
        const score = currentCard === 'Feuerwerk' ? restored.turnScore : 0;
        const won = currentCard === 'Feuerwerk' ? score > 0 : false;
        setSummaryData({ won, score, isTutto: false });
        setShowSummary(true);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRolls = currentRoll.filter(d => d.selected);
  const selectedVals = selectedRolls.map(d => d.val);

  const validation = useMemo(() => checkValidityAndScore(selectedVals, currentCard, kniffelProgress), [selectedVals, currentCard, kniffelProgress]);

  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => pendingTimers.current.forEach(clearTimeout), []);

  const roll = (numDice: number, kniffelArray: number[] | null = null, scoreSoFar = 0) => {
    pendingTimers.current.forEach(clearTimeout);
    pendingTimers.current = [];
    setIsRolling(true);
    setBustState(false);

    playTone(600, 'sine', 0.1);

    const newRollVals = Array.from({ length: numDice }, () => rollDie());
    // crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) —
    // this would throw on every roll when playing over plain http:// on a LAN.
    const finalRolls: DieType[] = newRollVals.map((val) => ({ id: uuidv4(), val, selected: false }));

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
        pendingTimers.current.push(setTimeout(() => {
          setRollingDiceIndices(prev => {
            const next = new Set(prev);
            next.delete(r.id);
            return next;
          });
          setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
          playTone(400 + (idx * 50), 'sine', 0.05);
        }, baseTumbleTime + (idx * staggerDelay)));
      }
    });

    const totalAnimationTime = baseTumbleTime + ((finalRolls.length - 1) * staggerDelay);

    const finalizeRoll = () => {
      setIsRolling(false);
      if (isBust(newRollVals, currentCard, kniffelArray || kniffelProgress)) {
        setBustState(true);
        playBuzzer();
        if (currentCard === 'Kleeblatt') {
          setShowSummary(true);
          setSummaryData({ won: false, score: 0 });
        } else {
          if (isTest) {
            if (currentCard === 'Feuerwerk') {
              setSummaryData({ won: scoreSoFar > 0, score: scoreSoFar, isTutto: false });
            } else {
              setSummaryData({ won: false, score: 0, isTutto: false });
            }
            setShowSummary(true);
          } else {
            pendingTimers.current.push(setTimeout(() => {
              if (currentCard === 'Feuerwerk') {
                setSummaryData({ won: scoreSoFar > 0, score: scoreSoFar, isTutto: false });
              } else {
                setSummaryData({ won: false, score: 0, isTutto: false });
              }
              setShowSummary(true);
            }, 1500));
          }
        }
      }
    };

    if (isTest) {
      finalizeRoll();
    } else {
      pendingTimers.current.push(setTimeout(finalizeRoll, totalAnimationTime + 100));
    }
  };

  useEffect(() => {
    if (rollingDiceIndices.size === 0) return;
    if (isTestEnv()) return;
    const interval = setInterval(() => {
      setDisplayRoll(prev => prev.map(d => {
        const isDieRolling = rollingDiceIndices.has(d.id);
        const correctVal = currentRoll.find(cr => cr.id === d.id)?.val;
        const isSettled = correctVal !== undefined && d.val === correctVal;
        return isDieRolling && !isSettled ? { ...d, val: Math.floor(Math.random() * 6) + 1 } : d;
      }));
    }, 80);
    return () => clearInterval(interval);
  }, [rollingDiceIndices, currentRoll]);

  const handleAction = (action: 'roll' | 'stop') => {
    if (!validation.valid && action !== 'stop') return;

    let newTurnScore = turnScore + validation.score;
    const newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];

    const isTutto = newKeptDice.length === 6;

    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore, currentCard);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();

      if (currentCard === 'Kleeblatt') {
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
      } else if (currentCard !== 'Feuerwerk') {
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

  const toggleDie = (id: string) => {
    if (bustState || showSummary || isRolling) return;
    setCurrentRoll(prev => prev.map(d => d.id === id ? { ...d, selected: !d.selected } : d));
  };

  const selectAllValid = () => {
    if (bustState || showSummary || isRolling || !hasRolled) return;
    const validIndices = new Set(getMaxValidSelection(currentRoll.map(d => d.val), currentCard, kniffelProgress));
    setCurrentRoll(prev => prev.map((d, i) => ({ ...d, selected: validIndices.has(i) })));
  };

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);

  useEffect(() => {
    if (!onStateChangeRef.current || !hasRolled || isRolling || bustState) return;
    const timer = setTimeout(() => {
      onStateChangeRef.current?.(buildDiceSnapshot({
        turnScore, keptDice, currentRoll, kniffelProgress, tuttosThisTurn, rollingDiceIndices,
      }));
    }, 300);
    return () => clearTimeout(timer);
  }, [keptDice, currentRoll, turnScore, hasRolled, rollingDiceIndices, isRolling, bustState, kniffelProgress, tuttosThisTurn]);

  useEffect(() => {
    if (!bustState || !onStateChangeRef.current || !hasRolled) return;
    onStateChangeRef.current?.(buildDiceSnapshot({
      turnScore, keptDice, currentRoll, kniffelProgress, tuttosThisTurn, busted: true,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bustState]);

  const summaryDataRef = useRef(summaryData);
  useEffect(() => { summaryDataRef.current = summaryData; }, [summaryData]);

  const finishGame = useCallback(() => {
    onComplete(summaryDataRef.current.score || 0, summaryDataRef.current.won || false);
  }, [onComplete]);

  // Auto-continue to the next player once the turn resolves — for a success the
  // same way as for a bust (the spectator view relies on this turn ending on its
  // own; only the active player can advance the shared game state).
  const continueCountdown = useAutoContinueCountdown({
    shouldStart: showSummary,
    onElapsed: finishGame,
  });

  const isMakingTutto = keptDice.length + selectedRolls.length === 6;
  const { canStop, isRollAgainApplicable, stopButtonText: stopButtonTextKey } = deriveTurnControls({
    currentCard,
    hasRolled,
    isRolling,
    bustState,
    validationValid: validation.valid,
    isMakingTutto,
    tuttosThisTurn,
  });
  const stopButtonText = t(stopButtonTextKey.key, stopButtonTextKey.fallback);

  const displayKeptDice = sortKeptDiceForDisplay(keptDice, currentCard, kniffelProgress);

  return (
    <div className="bg-white dark:bg-slate-800/95 backdrop-blur-xl border border-white/40 shadow-2xl overflow-hidden rounded-3xl flex flex-col items-center">
      {!showSummary && (
        <div className="w-full bg-black/5 dark:bg-white/5 border-b border-gray-200 dark:border-slate-600 p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 m-0">{t('dice.title', 'Dice Game')} - {getDisplayCardName(currentCard)}</h2>
          {!hasRolled && (
            <button className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors" onClick={onCancel} aria-label="Cancel dice roll">
              <X size={20} />
            </button>
          )}
        </div>
      )}

      <div className="p-8 w-full">
        {showSummary ? (
          <DiceSummary summaryData={summaryData} continueCountdown={continueCountdown} finishGame={finishGame} currentCard={currentCard} />
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">{t('dice.current_score', 'Current Score')}</div>
              <motion.div key={turnScore + (validation.valid ? validation.score : 0)} initial={{ scale: 1.2 }} animate={{ scale: 1 }} className="text-5xl font-black text-indigo-600 dark:text-indigo-400">
                {turnScore + (validation.valid ? validation.score : 0)}
              </motion.div>
              {currentCard === 'Kleeblatt' && (
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
                    <motion.div key={`kept-${i}`} initial={{ scale: 0, rotate: -180 }} animate={{ scale: 1, rotate: 0 }} className="die w-14 h-14 bg-indigo-600 text-white rounded-xl shadow-md flex items-center justify-center text-2xl font-bold border-2 border-indigo-400">
                      {d.val}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {displayKeptDice.length === 0 && <span className="text-gray-400 font-medium italic mx-auto">{t('dice.none', 'None')}</span>}
              </div>
            </div>

            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('dice.current_roll', 'Current Roll')}</h4>
                {hasRolled && !isRolling && !bustState && (
                  <button className="text-xs font-bold px-2.5 py-1 rounded-md border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors" onClick={selectAllValid}>
                    {t('dice.select_all_valid', 'Select all')}
                  </button>
                )}
              </div>
              {!hasRolled ? (
                <div className="py-8 text-center flex justify-center">
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-2xl text-xl font-bold flex items-center gap-3 shadow-lg shadow-indigo-500/30 transition-all" onClick={() => roll(6)}>
                    <Dices size={28} /> {t('dice.roll_6_dice', 'Roll 6 Dice')}
                  </motion.button>
                </div>
              ) : (
                <>
                  <div className="min-h-[80px] p-4 bg-white dark:bg-slate-800 rounded-2xl flex gap-3 flex-wrap justify-center border border-gray-200 dark:border-slate-600 shadow-sm">
                    {displayRoll.map(d => {
                      const isDieTumbling = rollingDiceIndices.has(d.id);
                      const isSelected = currentRoll.find(cr => cr.id === d.id)?.selected ?? false;
                      return (
                        <Die key={d.id} die={d} isSelected={isSelected} isDieTumbling={isDieTumbling} bustState={bustState} onToggle={toggleDie} />
                      );
                    })}
                  </div>
                  {bustState && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center text-red-500 text-2xl font-black mt-6 bg-red-50 py-3 rounded-xl border border-red-100">
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
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row gap-4 justify-center mt-8 pt-6 border-t border-gray-100 dark:border-slate-700">
                  {isRollAgainApplicable && (
                    <button
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      disabled={!validation.valid}
                      onClick={() => handleAction('roll')}
                    >
                      <RotateCw size={20} /> {t('dice.roll_again', 'Roll Again')}
                    </button>
                  )}
                  {canStop && (
                    <button
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      disabled={!validation.valid}
                      onClick={() => handleAction('stop')}
                    >
                      <Hand size={20} /> {stopButtonText}
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
