import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DiePips } from './Die';
import { DIE_FACE_SHUFFLE_MS } from '../../utils/uiTimings';
import { DIE_FACES } from '../../utils/turnShapes';
import type { Die as DieType } from '../../types';

interface SpectatorRollDieProps {
  die: DieType;
  isRolling: boolean;
  isBusted: boolean;
}

const randomFace = (): number => Math.floor(Math.random() * DIE_FACES) + 1;

/**
 * One die of the spectator's mirror of the active player's current roll.
 *
 * The live snapshot carries a roll's FINAL values from the moment it starts
 * (ROLL_STARTED dispatches them; the tumble on the roller's own screen is a
 * separate displayRoll), so a spectator used to read the outcome off the
 * pips a good half-second before the roller's dice had settled. While the
 * snapshot still flags this die as rolling, a shuffling random face is shown
 * instead — the same trick DiceGame plays for the roller — and the real value
 * appears only once the die drops out of rollingDiceIds.
 */
export default function SpectatorRollDie({ die, isRolling, isBusted }: SpectatorRollDieProps) {
  const { t } = useTranslation();
  // The face painted while rolling, plus the isRolling it was picked for.
  // A roll starting on an already-mounted die (the ids are fresh per roll, so
  // in practice a remount, but nothing enforces that) re-picks during render
  // rather than in an effect — so not even one frame shows the real value.
  const [shuffle, setShuffle] = useState(() => ({ rolling: isRolling, face: isRolling ? randomFace() : die.val }));
  if (shuffle.rolling !== isRolling) {
    setShuffle({ rolling: isRolling, face: isRolling ? randomFace() : die.val });
  }

  useEffect(() => {
    if (!isRolling) return;
    const interval = setInterval(
      () => setShuffle({ rolling: true, face: randomFace() }),
      DIE_FACE_SHUFFLE_MS,
    );
    return () => clearInterval(interval);
  }, [isRolling]);

  const shownValue = isRolling ? shuffle.face : die.val;

  return (
    <motion.div
      role="img"
      aria-label={t('dice.dieFace', 'Die showing {{value}}', { value: shownValue })}
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
          : die.selected
            ? 'bg-emerald-100 border-emerald-500 dark:bg-slate-700 dark:border-emerald-400'
            : 'bg-white dark:bg-slate-700 border-gray-300 dark:border-slate-500'
      }`}
    >
      {shownValue}
      <DiePips val={shownValue} isSelected={die.selected ?? false} bustState={isBusted} size="small" />
    </motion.div>
  );
}
