import { motion } from 'framer-motion';
import type { Die as DieType } from '../../types';

interface DieProps {
  die: DieType;
  isSelected: boolean;
  isDieTumbling: boolean;
  bustState: boolean;
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

export default function Die({ die, isSelected, isDieTumbling, bustState, onToggle }: DieProps) {
  return (
    <motion.button
      animate={{
        rotate: isDieTumbling ? [0, 90, 180, 270, 360] : 0,
        y: isDieTumbling ? [0, -20, 0] : 0,
      }}
      transition={{
        rotate: { repeat: isDieTumbling ? Infinity : 0, duration: 0.2 },
        y: { repeat: isDieTumbling ? Infinity : 0, duration: 0.15 },
      }}
      className={`die w-14 h-14 relative flex items-center justify-center text-transparent select-none outline-none focus:outline-none focus:ring-0 transition-all border-2
        ${isSelected
          ? 'bg-emerald-100 border-emerald-500 dark:bg-slate-700 dark:border-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.6)] scale-110 z-10'
          : bustState
            ? 'bg-red-50 border-red-300 opacity-70 cursor-default'
            : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-500 shadow-sm ' + (isDieTumbling ? '' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50')
        }
      `}
      onClick={() => onToggle(die.id)}
      disabled={bustState || isDieTumbling}
      aria-pressed={isSelected}
      aria-label={`Die showing ${die.val}, ${isSelected ? 'selected' : 'not selected'}`}
    >
      {die.val}
      <DiePips val={die.val} isSelected={isSelected} bustState={bustState} size="large" />
    </motion.button>
  );
}
