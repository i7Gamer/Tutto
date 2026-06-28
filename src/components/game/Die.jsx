import { motion } from 'framer-motion';

export default function Die({ die, isSelected, isDieTumbling, bustState, onToggle }) {
  return (
    <motion.button
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
          ? 'bg-emerald-100 border-emerald-500 text-emerald-700 dark:bg-slate-700 dark:border-emerald-400 dark:text-emerald-100 shadow-[0_0_25px_rgba(16,185,129,0.6)] scale-110 z-10'
          : bustState
            ? 'bg-red-50 border-red-300 text-red-500 opacity-70 cursor-default'
            : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-500 text-gray-800 dark:text-gray-100 shadow-sm ' + (isDieTumbling ? '' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50')
        }
      `}
      onClick={() => onToggle(die.id)}
      disabled={bustState || isDieTumbling}
      aria-pressed={isSelected}
      aria-label={`Die showing ${die.val}, ${isSelected ? 'selected' : 'not selected'}`}
    >
      {die.val}
    </motion.button>
  );
}
