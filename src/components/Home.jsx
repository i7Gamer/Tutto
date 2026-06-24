import { useGameStore } from '../store/useGameStore';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import ModeSelector from './home/ModeSelector';
import LocalLobby from './home/LocalLobby';
import OnlineLobby from './home/OnlineLobby';

export default function Home({ onShowStats }) {
  const { t } = useTranslation();
  const game = useGameStore();
  const { mode, setMode, roomId, leaveRoom } = game;

  const handleModeChange = (newMode) => {
    if (newMode === 'local' && roomId) {
      if (window.confirm(t('lobby.online.leaveConfirm', 'Do you really want to leave the room?'))) {
        leaveRoom();
        setMode('local');
      }
    } else {
      setMode(newMode);
    }
  };

  const handleClearCache = () => {
    if ('caches' in window) {
      caches.keys().then(names => {
        Promise.all(names.map(name => caches.delete(name))).then(() => {
          window.location.reload();
        }).catch(console.error);
      }).catch(console.error);
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-md flex-1 flex flex-col">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 rounded-3xl p-8 shadow-2xl relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
        
        <motion.h1 
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500 text-center mb-8 tracking-tight"
        >
          {t('app.title', 'Tutto')}
        </motion.h1>

        <ModeSelector 
          mode={mode} 
          onModeChange={handleModeChange} 
          onShowStats={onShowStats} 
          hasActiveRoom={mode === 'online' && !!roomId}
        />

        <div className="bg-black/5 dark:bg-white/5 rounded-2xl p-6 border border-gray-100 dark:border-slate-700">
          {mode === 'local' ? (
            <LocalLobby game={game} />
          ) : (
            <OnlineLobby game={game} />
          )}
        </div>

        <div className="text-center mt-10 text-sm text-gray-500 dark:text-gray-400 font-medium">
          {t('home.notSeeingFeatures', 'Not seeing the latest features? ')}
          <button 
            onClick={handleClearCache}
            className="text-indigo-600 hover:text-indigo-800 underline transition-colors cursor-pointer ml-1"
          >
            {t('home.clearCache', 'Clear Cache & Reload')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
