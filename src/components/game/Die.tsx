import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { Die as DieType } from '../../types';

interface DieProps {
  die: DieType;
  isSelected: boolean;
  isDieTumbling: boolean;
  bustState: boolean;
  // The roll as a whole has not finalized yet. A die stops tumbling before its
  // roll does (the last one settles a settle buffer ahead of the bust check),
  // and DiceGame drops clicks on every die until then — so without this the
  // die kept offering a pointer cursor and a hover highlight for a click that
  // was going to be swallowed. Defaults to false: a die rendered outside a
  // live roll has nothing to wait for.
  isRollPending?: boolean;
  // The current card makes the selection for you and refuses to let it be
  // edited (official Feuerwerk keeps every scoring die), so DiceGame's toggle
  // is a no-op for every die on the board — the same look-clickable/act-dead
  // mismatch as isRollPending, just for the whole card instead of one roll.
  // Defaults to false: most cards let you pick your own dice.
  isSelectionLocked?: boolean;
  onToggle: (id: string) => void;
}

const PIP_POSITIONS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const GRID_SIZE = 9;

export function DiePips({
  val,
  isSelected,
  bustState,
  size = 'large',
  isIndigo = false,
}: {
  val: number;
  isSelected: boolean;
  bustState: boolean;
  size?: 'large' | 'small';
  isIndigo?: boolean;
}) {
  const isLarge = size === 'large';
  return (
    <div
      className={`grid grid-cols-3 grid-rows-3 absolute inset-0 pointer-events-none ${
        isLarge ? 'gap-1 p-2.5' : 'gap-0.5 p-1.5'
      }`}
    >
      {Array.from({ length: GRID_SIZE }).map((_, index) => {
        const isPipActive = PIP_POSITIONS[val]?.includes(index);
        return (
          <div
            key={index}
            className={`rounded-full transition-all duration-200 justify-self-center self-center ${
              isLarge ? 'w-2 h-2' : 'w-1.5 h-1.5'
            } ${
              isPipActive
                ? isIndigo
                  ? 'bg-white scale-100'
                  : isSelected
                    ? 'bg-emerald-700 dark:bg-emerald-100 scale-100'
                    : bustState
                      ? 'bg-red-500 scale-100'
                      : 'bg-gray-800 dark:bg-gray-100 scale-100'
                : 'bg-transparent scale-0'
            }`}
          />
        );
      })}
    </div>
  );
}

export default function Die({ die, isSelected, isDieTumbling, bustState, isRollPending = false, isSelectionLocked = false, onToggle }: DieProps) {
  const { t } = useTranslation();
  const isClickable = !bustState && !isDieTumbling && !isRollPending && !isSelectionLocked;
  return (
    <motion.button
      // A test hook, not styling — it was a bare `die` class, which is a name
      // Tailwind could plausibly own one day. That is how the Stop card lost its
      // ring in the v4 upgrade: a hand-written class in the utility namespace,
      // silently renamed by a codemod that took it for a utility.
      data-testid="die"
      animate={{
        rotate: isDieTumbling ? [0, 90, 180, 270, 360] : 0,
        y: isDieTumbling ? [0, -20, 0] : 0,
      }}
      transition={{
        rotate: { repeat: isDieTumbling ? Infinity : 0, duration: 0.2 },
        y: { repeat: isDieTumbling ? Infinity : 0, duration: 0.15 },
      }}
      className={`w-14 h-14 relative rounded-xl flex items-center justify-center text-transparent select-none outline-hidden focus:outline-hidden focus:ring-0 transition-all border-2
        ${isSelected
          ? 'bg-emerald-100 border-emerald-500 dark:bg-slate-700 dark:border-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.6)] scale-110 z-10'
          : bustState
            ? 'bg-red-50 border-red-300 opacity-70 cursor-default'
            : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-500 shadow-xs ' + (isClickable ? 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50' : '')
        }
      `}
      onClick={() => onToggle(die.id)}
      disabled={!isClickable}
      aria-pressed={isSelected}
      // The label was hardcoded English — the one string in the game a German
      // screen-reader user always heard untranslated. A translated prefix with
      // the value appended (rather than interpolated into the phrase) because
      // the test i18n mock returns bare keys: interpolation would make every
      // die's accessible name identical under test. Selection state is NOT in
      // the label — aria-pressed above already announces it, and unlike label
      // text it announces the CHANGE on toggle.
      aria-label={`${t('dice.die_showing', 'Die showing')} ${die.val}`}
    >
      {die.val}
      <DiePips val={die.val} isSelected={isSelected} bustState={bustState} size="large" />
    </motion.button>
  );
}
