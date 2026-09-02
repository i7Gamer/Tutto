import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { DiePips } from './Die';
import type { Die as DieType } from '../../types';

interface KeptDiceTrayProps {
  // Already in display order (sortKeptDiceForDisplay) — this tray only renders.
  keptDice: DieType[];
}

export default function KeptDiceTray({ keptDice }: KeptDiceTrayProps) {
  const { t } = useTranslation();

  return (
    <div className="mb-6">
      <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('dice.kept_dice', 'Kept Dice')}</h4>
      <div className="min-h-[80px] p-4 bg-black/5 dark:bg-white/5 rounded-2xl flex gap-3 flex-wrap items-center border border-gray-200 dark:border-slate-600/50 shadow-inner">
        <AnimatePresence>
          {/* Keyed by die id, not index: Kniffel re-sorts kept dice for
              display, and index keys would pin AnimatePresence's enter/
              exit animations to the wrong die after a reorder. */}
          {keptDice.map(d => (
            // The face is pips — SVG circles carrying no text — so without a
            // name of its own a banked die is invisible to a screen reader.
            <motion.div key={d.id} data-testid="die" role="img" aria-label={t('dice.dieFace', 'Die showing {{value}}', { value: d.val })} initial={{ scale: 0, rotate: -180 }} animate={{ scale: 1, rotate: 0 }} className="relative w-14 h-14 bg-indigo-600 text-white rounded-xl shadow-md flex items-center justify-center border-2 border-indigo-400">
              <DiePips val={d.val} isSelected={false} bustState={false} size="large" isIndigo />
            </motion.div>
          ))}
        </AnimatePresence>
        {keptDice.length === 0 && <span className="text-gray-500 dark:text-gray-400 font-medium italic mx-auto">{t('dice.none', 'None')}</span>}
      </div>
    </div>
  );
}
