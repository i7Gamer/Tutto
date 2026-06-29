import { User, Globe, BarChart2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

type GameMode = 'local' | 'online';

interface ModeSelectorProps {
  mode: GameMode;
  onModeChange: (mode: GameMode) => void;
  onShowStats: () => void;
  hasActiveRoom: boolean;
}

export default function ModeSelector({ mode, onModeChange, onShowStats, hasActiveRoom }: ModeSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center mb-8">
      <div className="flex gap-4 mb-4">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${mode === 'local' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800/50 text-gray-700 dark:text-gray-200 hover:bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600'}`}
          onClick={() => onModeChange('local')}
        >
          <User size={20} /> {t('home.localPlay', 'Local Play')}
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${mode === 'online' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800/50 text-gray-700 dark:text-gray-200 hover:bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600'}`}
          onClick={() => onModeChange('online')}
        >
          <Globe size={20} /> {t('home.onlinePlay', 'Online Play')}
        </motion.button>
      </div>

      {!hasActiveRoom && (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex items-center gap-2 px-6 py-2 rounded-lg bg-white dark:bg-slate-800/40 hover:bg-white dark:bg-slate-800/80 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-gray-200 font-medium transition-all w-full max-w-xs justify-center"
          onClick={onShowStats}
        >
          <BarChart2 size={18} /> {t('home.viewStats', 'View Statistics')}
        </motion.button>
      )}
    </div>
  );
}
