import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sun, Moon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from './store/useGameStore';
import { warnAboutRecentCrash } from './utils/crashLog';
import { TOAST_LIFETIME_MS, JOIN_TIMEOUT_MS } from './utils/uiTimings';
import Home from './components/Home';
import Game from './components/Game';
import EndScreen from './components/EndScreen';
import Statistics from './components/Statistics';
import LanguageSwitcher from './components/LanguageSwitcher';
import HelpPopup from './components/HelpPopup';
import ModalShell from './components/ModalShell';
import ReactionOverlay from './components/ReactionOverlay';
import IOSHapticProxy from './components/IOSHapticProxy';
import './index.css';
import type { Toast } from './types';

interface ToastItemProps {
  toast: Toast;
  removeToast: (id: number) => void;
}

function ToastItem({ toast, removeToast }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => removeToast(toast.id), TOAST_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [toast.id, removeToast]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="bg-gray-900/90 dark:bg-slate-800 text-white px-4 py-2 rounded-xl shadow-lg font-medium border border-gray-700 backdrop-blur-md text-sm whitespace-nowrap text-center pointer-events-auto"
    >
      {toast.message}
    </motion.div>
  );
}

function ToastMessage() {
  const toasts = useGameStore(state => state.toasts);
  const removeToast = useGameStore(state => state.removeToast);

  return (
    // Toasts are the app's only channel for a whole class of news — a link
    // copied, a dice game resumed, a join refused, a player kicked — and
    // nothing ever moves focus to them. Announced politely so they do not cut
    // across whatever is being read mid-turn.
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[150] flex flex-col gap-2 pointer-events-none"
    >
      <AnimatePresence>
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} removeToast={removeToast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ReconnectPopup() {
  const showReconnectPopup = useGameStore(state => state.showReconnectPopup);
  const cancelReconnect = useGameStore(state => state.cancelReconnect);
  const setMode = useGameStore(state => state.setMode);
  const { t } = useTranslation();

  // No onDismiss: this reports a state the player cannot walk away from, so
  // neither Escape nor a click outside may quietly close it.
  return (
    <ModalShell open={showReconnectPopup}>
        <div className="text-amber-500 mb-4 flex justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.578"/><path d="M22.016 11.664v-1.664h-1.664"/><path d="M2.383 14.156a10.742 10.742 0 0 1-1.074-6.49M2.08 7.666v1.665h1.665"/><path d="M7 16l-3.32-3.32"/><path d="M20.32 8.68L17 12"/><path d="m2 2 20 20"/></svg>
        </div>
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">{t('home.reconnect.title', 'Connection Lost')}</h3>
        <p className="text-gray-600 dark:text-gray-400 mb-6">{t('home.reconnect.description', 'You have lost connection to the server. Attempting to automatically reconnect...')}</p>
        <div className="flex flex-col gap-3">
          <button
            className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-4 rounded-xl transition-colors"
            onClick={() => { cancelReconnect(); setMode('local'); }}
          >
            {t('home.reconnect.returnMenu', 'Return to Main Menu')}
          </button>
        </div>
    </ModalShell>
  );
}

function RestoreSessionPopup() {
  const pendingReconnectSession = useGameStore(state => state.pendingReconnectSession);
  const clearPendingReconnect = useGameStore(state => state.clearPendingReconnect);
  const cancelReconnect = useGameStore(state => state.cancelReconnect);
  const joinRoom = useGameStore(state => state.joinRoom);
  const addToast = useGameStore(state => state.addToast);
  const { t } = useTranslation();

  // Unmounted rather than closed, because the body reads the session it is
  // asking about. No onDismiss either: this asks a question with consequences
  // both ways (the "No" answer gives the seat up), so it is answered rather
  // than dismissed.
  if (!pendingReconnectSession) return null;

  return (
    <ModalShell open>
        <div className="text-indigo-500 mb-4 flex justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m19 19-4-4m0-7A7 7 0 1 1 5.1 8a7 7 0 0 1 9.9 0z"/></svg>
        </div>
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">{t('home.restore.title', 'Ongoing Game Found')}</h3>
        <p className="text-gray-600 dark:text-gray-400 mb-6">{t('home.restore.description', 'You were recently in an online room ({{roomId}}). Do you want to reconnect?', { roomId: pendingReconnectSession.roomId })}</p>
        <div className="flex flex-col gap-3">
          <button
            className="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-3 px-4 rounded-xl transition-colors"
            onClick={async () => {
              useGameStore.setState({ showReconnectPopup: true });
              const { roomId, myName } = pendingReconnectSession;
              clearPendingReconnect();
              // Raced against the same deadline the lobby's join button uses:
              // joinRoom resolves only on the server's ack, which may never
              // arrive (server down mid-restart, lost ack) — without it, the
              // "Connection Lost" popup shows "attempting to reconnect"
              // forever, with the menu button as the only escape.
              let watchdog: ReturnType<typeof setTimeout> | undefined;
              const res = await Promise.race([
                joinRoom(roomId, myName, true),
                new Promise<{ success: false; error: string }>((resolve) => {
                  watchdog = setTimeout(
                    () => resolve({ success: false, error: t('lobby.online.joinTimeout', 'No response from the server. Please try again.') }),
                    JOIN_TIMEOUT_MS,
                  );
                }),
              ]);
              clearTimeout(watchdog);
              if (!res.success) {
                // joinRoom failed outright (room gone, name taken, timed out) —
                // there will be no gameState event to clear showReconnectPopup,
                // so the "Connection Lost" popup would otherwise stay up forever.
                useGameStore.setState({ showReconnectPopup: false });
                addToast(res.error || t('home.restore.failed', 'Failed to reconnect to the game'));
              }
            }}
          >
            {t('home.restore.yes', 'Yes, Reconnect')}
          </button>
          <button
            className="w-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-200 font-bold py-3 px-4 rounded-xl transition-colors"
            onClick={() => { cancelReconnect(pendingReconnectSession.roomId, pendingReconnectSession.myName); }}
          >
            {t('home.restore.cancel', 'No, Cancel')}
          </button>
        </div>
    </ModalShell>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState(() => localStorage.getItem('tutto-theme') || 'light');

  const [deviceId] = useState(() => {
    let id = localStorage.getItem('tutto_device_id');
    if (!id) {
      id = uuidv4();
      localStorage.setItem('tutto_device_id', id);
    }
    return id;
  });

  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    useGameStore.getState().init(deviceId);
    // If the ErrorBoundary auto-reloaded after a crash, the stored report is
    // the only remaining trace — surface it for anyone with devtools open.
    warnAboutRecentCrash();
  }, [deviceId]);

  const finished = useGameStore(state => state.finished);
  const currentPlayerIndex = useGameStore(state => state.currentPlayerIndex);
  const players = useGameStore(state => state.players);

  const hasWinner = finished && players.length > 0;
  const isPlaying = currentPlayerIndex !== null && players.length > 0;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tutto-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    // The effect above applies the DOM attribute (and persists it) whenever
    // `theme` changes — no need to also set it here.
    setTheme(theme === 'light' ? 'dark' : 'light');
  };

  return (
    <>
      <div style={{ position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 100, display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <LanguageSwitcher />
        <button className="theme-toggle" onClick={toggleTheme} aria-label={t('app.toggleTheme', 'Toggle theme')} style={{ background: 'var(--card-bg)', boxShadow: 'var(--shadow-md)' }}>
          {theme === 'light' ? <Moon size={24} /> : <Sun size={24} />}
        </button>
      </div>

      <ToastMessage />
      <ReconnectPopup />
      <RestoreSessionPopup />
      <HelpPopup />
      <ReactionOverlay />
      <IOSHapticProxy />

      {showStats ? (
        <Statistics deviceId={deviceId} onBack={() => setShowStats(false)} />
      ) : hasWinner ? (
        <EndScreen theme={theme} deviceId={deviceId} />
      ) : isPlaying ? (
        <Game />
      ) : (
        <Home onShowStats={() => setShowStats(true)} />
      )}
    </>
  );
}
