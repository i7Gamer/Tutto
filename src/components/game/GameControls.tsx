import { useState, useEffect } from 'react';
import { Undo2, ChevronRight, Check, X, Dices, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { isTestEnv } from '../../utils/env';
import { sortKeptDiceForDisplay, hasScoreInput, isSpecialCard } from '../../utils/diceTurnControls';
import { CARD_FLIP_MS } from '../../utils/uiTimings';
import { BONUS_CARDS, DEFAULT_RULESET } from '../../utils/configValidation';
import type { CardType, DiceMode, DiceSnapshot, Player, Ruleset } from '../../types';
import { DiePips } from './Die';
import ConfirmModal from '../ConfirmModal';

interface GameControlsProps {
  currentCard: CardType | null;
  cardsLength: number;
  isMyTurn: boolean;
  diceMode: DiceMode;
  ruleset?: Ruleset;
  setShowDiceGame: (show: boolean) => void;
  scoreInput: string;
  setScoreInput: (val: string | ((prev: string) => string)) => void;
  applyBonus: boolean;
  setApplyBonus: (val: boolean) => void;
  handleNextTurn: () => void;
  handleYesNo: (isSuccess: boolean) => void;
  // Classic physical chains: reveals the next card mid-turn. Rendered only
  // when provided (Game passes it for classic + physical dice).
  onDrawNextCard?: () => void;
  // A special card's Yes was answered under classic — the yes/no buttons
  // give way to the bank-total input plus the draw button.
  awaitingChainChoice?: boolean;
  undo: () => void;
  canUndo: boolean;
  endGame: () => void;
  isOnline: boolean;
  isHost: boolean;
  leaveRoom: () => void;
  activeTurnState: DiceSnapshot | null;
  currentPlayer: Player | null | undefined;
}

export default function GameControls({
  currentCard,
  cardsLength,
  isMyTurn,
  diceMode,
  ruleset = DEFAULT_RULESET,
  setShowDiceGame,
  scoreInput,
  setScoreInput,
  applyBonus,
  setApplyBonus,
  handleNextTurn,
  handleYesNo,
  onDrawNextCard,
  awaitingChainChoice = false,
  undo,
  canUndo,
  endGame,
  isOnline,
  isHost,
  leaveRoom,
  activeTurnState,
  currentPlayer,
}: GameControlsProps) {
  const { t } = useTranslation();
  const currentCardHasInput = hasScoreInput(currentCard);
  const currentCardHasYesNo = isSpecialCard(currentCard);
  const isStopCard = currentCard === 'Stop';

  const [prevCardsLength, setPrevCardsLength] = useState(cardsLength);
  const [prevCard, setPrevCard] = useState<CardType | null>(currentCard);
  const [isFlipping, setIsFlipping] = useState(false);
  // Which of the three confirm-gated actions below is pending a yes/no from
  // ConfirmModal — replaces the blocking window.confirm() every one of them
  // used to call directly.
  const [pendingAction, setPendingAction] = useState<'end' | 'leave' | 'undo' | null>(null);

  // Synchronous render-time derived state: must run before paint so isFlipping
  // is true on the same frame the new card arrives, preventing a visible flash.
  if (cardsLength !== prevCardsLength || currentCard !== prevCard) {
    setPrevCardsLength(cardsLength);
    setPrevCard(currentCard);
    if (!isTestEnv() && (currentCard || prevCard)) {
      setIsFlipping(true);
    } else if (!currentCard) {
      setIsFlipping(false);
    }
  }

  useEffect(() => {
    if (isFlipping && currentCard) {
      const timer = setTimeout(() => setIsFlipping(false), CARD_FLIP_MS);
      return () => clearTimeout(timer);
    }
  }, [isFlipping, currentCard]);

  const addScore = (val: number) => {
    setScoreInput(prev => {
      const current = parseInt(prev, 10) || 0;
      return (current + val).toString();
    });
  };

  return (
    <div className="flex flex-col bg-[var(--card-bg)] backdrop-blur border border-white/40 rounded-3xl p-4 md:p-6 shadow-xl relative overflow-hidden h-full w-full min-h-[360px] md:min-h-[400px]">
      <div className="flex-1 flex flex-col justify-center items-center w-full min-h-[220px]">
        <AnimatePresence mode="wait">
          {isMyTurn && !isStopCard && !isFlipping && (
            <motion.div
              key="input-controls"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full flex flex-col items-center"
            >
              {diceMode === 'digital' && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-indigo-500/30 transition-colors mb-4"
                  onClick={() => setShowDiceGame(true)}
                >
                  <Dices className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.rollDice', 'Roll Dice')}
                </motion.button>
              )}

              {(currentCardHasInput || awaitingChainChoice) && diceMode === 'physical' && (
                <>
                  <div className="flex flex-row items-center gap-3 mb-4 md:mb-6 w-full max-w-sm">
                    <label htmlFor="score-input" className="sr-only">{t('game.controls.scorePlaceholder', 'Score')}</label>
                    <input
                      id="score-input"
                      type="number"
                      min="0"
                      value={scoreInput}
                      onChange={(e) => setScoreInput(e.target.value)}
                      placeholder={t('game.controls.scorePlaceholder', 'Score')}
                      className="flex-1 min-w-0 w-full text-center text-2xl md:text-3xl font-bold py-3 md:py-4 rounded-2xl border-2 border-gray-200 dark:border-slate-600 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 bg-[var(--card-bg)] transition-all outline-none"
                    />
                    {/* The cards that change what a manually entered score is
                        worth: the flat bonuses, plus the doubler. Hidden for
                        classic: it is keyed to the card showing at entry
                        time, which is wrong mid-chain (a classic x2 doubles
                        the WHOLE accumulated total) — the player enters the
                        fully-computed final total instead. */}
                    {ruleset !== 'classic' && ([...BONUS_CARDS, 'x2'] as string[]).includes(currentCard ?? '') && (
                      <div className="flex items-center bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-3 py-2 md:py-3 rounded-2xl border border-amber-200 dark:border-amber-800 h-full">
                        <label className="checkbox-wrapper">
                          <input type="checkbox" checked={applyBonus} onChange={(e) => setApplyBonus(e.target.checked)} />
                          <span className="text-xs md:text-sm whitespace-nowrap font-semibold">{t('game.controls.applyBonus', 'Apply bonus')}</span>
                        </label>
                      </div>
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
                    {t('game.controls.nextTurn', 'Next Turn')} <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
                  </motion.button>

                  {onDrawNextCard && (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      data-testid="physical-draw-next-card"
                      className="mt-3 bg-amber-500 hover:bg-amber-600 text-white w-full max-w-sm py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 md:gap-3 shadow-lg shadow-amber-500/30 transition-colors"
                      onClick={onDrawNextCard}
                    >
                      {t('dice.draw_next_card', 'Draw next card — risk everything!')} <Layers className="w-5 h-5 md:w-6 md:h-6" />
                    </motion.button>
                  )}
                </>
              )}

              {currentCardHasYesNo && diceMode === 'physical' && !awaitingChainChoice && (
                <div className="w-full mt-2">
                  <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 text-center">{t('game.controls.didYouSucceed', 'Did you succeed?')}</h4>
                  <div className="flex gap-4 w-full max-w-sm mx-auto">
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-emerald-500/30 transition-colors"
                      onClick={() => handleYesNo(true)}
                    >
                      <Check className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.yes', 'Yes')}
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-lg md:text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-red-500/30 transition-colors"
                      onClick={() => handleYesNo(false)}
                    >
                      <X className="w-5 h-5 md:w-6 md:h-6" /> {t('game.controls.no', 'No')}
                    </motion.button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {isMyTurn && isStopCard && !isFlipping && (
            <motion.div
              key="stop-controls"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center justify-center w-full text-center"
            >
              <h4 className="text-2xl font-bold text-red-500 mb-6">{t('game.controls.stopTurnOver', 'Stop! Your turn is over.')}</h4>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="bg-red-500 hover:bg-red-600 text-white w-full max-w-sm py-4 rounded-2xl text-xl font-bold flex justify-center items-center gap-3 shadow-lg shadow-red-500/30 transition-colors"
                onClick={() => handleYesNo(false)}
              >
                {t('game.controls.continue', 'Continue')} <ChevronRight size={24} />
              </motion.button>
            </motion.div>
          )}

          {!isMyTurn && (
            <motion.div
              key="waiting-controls"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center w-full text-center"
            >
              {/* The live view mirrors the ACTIVE player's digital dice; the
                  viewer's own diceMode is a per-device input preference and
                  must not hide it (physical-dice spectators watch too). */}
              {isOnline && activeTurnState ? (
                <div className="w-full">
                  <p className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                    {t('game.controls.playerIsPlaying', '{{name}} is playing', { name: currentPlayer?.name ?? '' })}
                  </p>
                  <div className="text-4xl font-black text-indigo-600 dark:text-indigo-400 mb-4">
                    {activeTurnState.turnScore}
                  </div>
                  {(activeTurnState.cardsThisTurn?.length ?? 0) > 1 && (
                    <p className="text-xs font-bold text-indigo-500 uppercase tracking-wider -mt-3 mb-4">
                      {t('game.controls.chainCard', 'Card {{count}} of this turn', { count: activeTurnState.cardsThisTurn?.length })}
                    </p>
                  )}
                  {activeTurnState.keptDice.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">{t('game.controls.keptDice', 'Kept Dice')}</p>
                      <div className="flex gap-2 flex-wrap justify-center">
                        {sortKeptDiceForDisplay(activeTurnState.keptDice, currentCard, activeTurnState.kniffelProgress, ruleset).map((d) => (
                          <div key={d.id} className="w-10 h-10 bg-indigo-600 text-transparent rounded-xl flex items-center justify-center text-xl font-bold border-2 border-indigo-400 relative">
                            {d.val}
                            <DiePips val={d.val} isSelected={false} bustState={false} size="small" isIndigo={true} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeTurnState.currentRoll.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">{t('game.controls.currentRoll', 'Current Roll')}</p>
                      <div className="flex gap-2 flex-wrap justify-center">
                        {activeTurnState.currentRoll.map((d) => {
                          const isRolling = activeTurnState.rollingDiceIds?.includes(d.id) ?? false;
                          const isBusted = activeTurnState.busted ?? false;
                          return (
                            <motion.div
                              key={d.id}
                              animate={{
                                rotate: isRolling ? [0, 90, 180, 270, 360] : 0,
                                y: isRolling ? [0, -15, 0] : 0,
                              }}
                              transition={{
                                rotate: { repeat: isRolling ? Infinity : 0, duration: 0.2 },
                                y: { repeat: isRolling ? Infinity : 0, duration: 0.15 },
                              }}
                              className={`w-10 h-10 rounded-xl flex items-center justify-center text-transparent border-2 relative ${
                                isBusted
                                  ? 'bg-red-50 border-red-300 opacity-70'
                                  : d.selected
                                    ? 'bg-emerald-100 border-emerald-500 dark:bg-slate-700 dark:border-emerald-400'
                                    : 'bg-white dark:bg-slate-700 border-gray-300 dark:border-slate-500'
                              }`}
                            >
                              {d.val}
                              <DiePips val={d.val} isSelected={d.selected} bustState={isBusted} size="small" />
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin mb-4"></div>
                  <h4 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('game.controls.waiting', 'Waiting for other player...')}</h4>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex justify-between w-full mt-auto pt-6 border-t border-gray-100 dark:border-slate-700">
        {(!isOnline || isHost) ? (
          <button
            className="flex items-center gap-2 text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => setPendingAction('end')}
          >
            <X size={18} /> {t('game.controls.endGame', 'End Game')}
          </button>
        ) : (
          <button
            className="flex items-center gap-2 text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg font-medium transition-colors"
            onClick={() => setPendingAction('leave')}
            aria-label={t('game.controls.leaveGame', 'Leave Game')}
            title={t('game.controls.leaveGame', 'Leave Game')}
          >
            {/* Icon-only on phones — the label costs bottom-bar width the
                score input needs more. */}
            <X size={18} /> <span className="hidden sm:inline">{t('game.controls.leaveGame', 'Leave Game')}</span>
          </button>
        )}
        <button
          className="flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:bg-white/5 hover:text-gray-800 dark:text-gray-100 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none"
          onClick={() => setPendingAction('undo')}
          disabled={!canUndo}
        >
          <Undo2 size={18} /> {t('game.controls.undo', 'Undo')}
        </button>
      </div>

      <ConfirmModal
        open={pendingAction !== null}
        danger={pendingAction === 'end' || pendingAction === 'leave'}
        message={
          pendingAction === 'end'
            ? t('game.controls.endGameConfirm', 'Do you really want to end the game?')
            : pendingAction === 'leave'
              ? t('game.controls.leaveGameConfirm', 'Do you really want to leave the game?')
              : t('game.controls.undoConfirm', 'Undo the last turn?')
        }
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction === 'end') endGame();
          else if (pendingAction === 'leave') leaveRoom();
          else if (pendingAction === 'undo') undo();
          setPendingAction(null);
        }}
      />
    </div>
  );
}
