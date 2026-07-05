import { useGameStore } from '../store/useGameStore';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import ModeSelector from './home/ModeSelector';
import LocalLobby from './home/LocalLobby';
import OnlineLobby from './home/OnlineLobby';

interface HomeProps {
  onShowStats: () => void;
}

export default function Home({ onShowStats }: HomeProps) {
  const { t } = useTranslation();
  const game = useGameStore();
  const { mode, setMode, roomId, leaveRoom } = game;

  const handleModeChange = (newMode: 'local' | 'online') => {
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
    localStorage.removeItem('tutto_dice_turn_state');
    localStorage.removeItem('tutto_local_game');
    localStorage.removeItem('last_crash_time');
    sessionStorage.removeItem('tutto_online_session');

    // The Cache Storage API is only exposed on secure contexts (HTTPS/localhost).
    // This app is explicitly playable over plain http:// on a LAN (see the
    // crypto.randomUUID() note in DiceGame.tsx for the same constraint), where
    // `caches` is undefined — referencing it directly would throw before the
    // reload below ever ran, leaving storage half-cleared and no reload.
    if (typeof caches === 'undefined') {
      window.location.reload();
      return;
    }

    caches.keys().then(names => {
      Promise.all(names.map(name => caches.delete(name))).then(() => {
        window.location.reload();
      }).catch((err) => {
        // Reload must happen even if a cache failed to delete — otherwise this
        // explicit "reload" button silently does nothing from the user's
        // perspective beyond the console error.
        console.error(err);
        window.location.reload();
      });
    }).catch(() => window.location.reload());
  };

  return (
    // pb-20 mirrors Game.tsx's own bottom padding — without it, this page's
    // content can sit directly behind the fixed Help button (bottom-6 left-6)
    // and theme/language toggles (bottom-4 right-4) instead of clearing them.
    // max-w-4xl (up from max-w-3xl): at the lg: breakpoint the advanced-options
    // grids switch to 3/4 columns (LobbyShared.tsx) — at max-w-3xl those columns
    // were too narrow for their own labels ("Winning Score", "Kick Timer (s)",
    // longer card names like "Plus/Minus"), which get whitespace-nowrap +
    // text-ellipsis and were silently truncating regardless of how wide the
    // actual browser window was.
    <div className="container mx-auto px-2 sm:px-4 pt-4 md:pt-8 pb-20 max-w-4xl flex-1 flex flex-col">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 rounded-3xl p-4 sm:p-6 md:p-8 shadow-2xl relative overflow-hidden flex-1 flex flex-col"
      >
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

        <motion.h1
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500 text-center mb-6 sm:mb-8 tracking-tight"
        >
          {t('app.title', 'Tutto')}
        </motion.h1>

        <ModeSelector
          mode={mode}
          onModeChange={handleModeChange}
          onShowStats={onShowStats}
          hasActiveRoom={mode === 'online' && !!roomId}
        />

        <div className="bg-black/5 dark:bg-white/5 rounded-2xl p-4 sm:p-6 border border-gray-100 dark:border-slate-700">
          {mode === 'local' ? <LocalLobby game={game} /> : <OnlineLobby game={game} />}
        </div>

        <div className="text-center mt-10 text-sm text-gray-500 dark:text-gray-400 font-medium">
          {t('home.notSeeingFeatures', 'Not seeing the latest features? ')}
          <button onClick={handleClearCache} className="text-indigo-600 hover:text-indigo-800 underline transition-colors cursor-pointer ml-1">
            {t('home.clearCache', 'Clear Cache & Reload')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
