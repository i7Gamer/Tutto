import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Hand, Layers, RotateCw } from 'lucide-react';

export type TurnAction = 'roll' | 'stop' | 'draw';

interface TurnActionBarProps {
  // Mounted at all (the whole row animates in once the first roll lands).
  show: boolean;
  // Whether pressing would do anything right now (selection valid, no roll in
  // flight). The buttons disable in place on this rather than unmounting —
  // see deriveTurnControls on why mount and enable are kept separate.
  actionable: boolean;
  isRollAgainApplicable: boolean;
  canStop: boolean;
  stopButtonText: string;
  canDrawAfterTutto: boolean;
  onAction: (action: TurnAction) => void;
}

const ENABLED_STYLES: Record<TurnAction, string> = {
  roll: 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/30',
  stop: 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30',
  draw: 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/30',
};

const DISABLED_STYLE = 'bg-gray-200 text-gray-400 cursor-not-allowed';

export default function TurnActionBar({ show, actionable, isRollAgainApplicable, canStop, stopButtonText, canDrawAfterTutto, onAction }: TurnActionBarProps) {
  const { t } = useTranslation();

  const buttonClass = (action: TurnAction): string =>
    `flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${actionable ? ENABLED_STYLES[action] : DISABLED_STYLE}`;

  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row gap-4 justify-center mt-8 pt-6 border-t border-gray-100 dark:border-slate-700">
          {isRollAgainApplicable && (
            <button className={buttonClass('roll')} disabled={!actionable} onClick={() => onAction('roll')}>
              <RotateCw size={20} /> {t('dice.roll_again', 'Roll Again')}
            </button>
          )}
          {canStop && (
            <button className={buttonClass('stop')} disabled={!actionable} onClick={() => onAction('stop')}>
              <Hand size={20} /> {stopButtonText}
            </button>
          )}
          {canDrawAfterTutto && (
            <button data-testid="draw-next-card" className={buttonClass('draw')} disabled={!actionable} onClick={() => onAction('draw')}>
              <Layers size={20} /> {t('dice.draw_next_card', 'Draw next card — risk everything!')}
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
