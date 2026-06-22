import React, { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useGameStore } from './store/useGameStore';
import Home from './components/Home';
import Game from './components/Game';
import EndScreen from './components/EndScreen';
import Statistics from './components/Statistics';
import './index.css';

function ToastMessage() {
  const toastMessage = useGameStore(state => state.toastMessage);
  const clearToast = useGameStore(state => state.clearToast);

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(clearToast, 5000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage, clearToast]);

  if (!toastMessage) return null;

  return (
    <div className="toast-notification fixed top-4 left-1/2 -translate-x-1/2 z-[150] bg-gray-900/90 dark:bg-slate-800 text-white px-6 py-3 rounded-full shadow-2xl font-medium border border-gray-700 backdrop-blur-md">
      {toastMessage}
    </div>
  );
}

function ReconnectPopup() {
  const showReconnectPopup = useGameStore(state => state.showReconnectPopup);
  const setMode = useGameStore(state => state.setMode);

  if (!showReconnectPopup) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl border border-gray-100 dark:border-slate-700 text-center animate-bounce-in">
        <div className="text-amber-500 mb-4 flex justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.578"/><path d="M22.016 11.664v-1.664h-1.664"/><path d="M2.383 14.156a10.742 10.742 0 0 1-1.074-6.49M2.08 7.666v1.665h1.665"/><path d="M7 16l-3.32-3.32"/><path d="M20.32 8.68L17 12"/><path d="m2 2 20 20"/></svg>
        </div>
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-2">Connection Lost</h3>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          You have lost connection to the server. Attempting to automatically reconnect...
        </p>
        <div className="flex flex-col gap-3">
          <button 
            className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-4 rounded-xl transition-colors"
            onClick={() => {
              useGameStore.setState({ showReconnectPopup: false, roomId: null, isHost: false, hostId: null, myName: null });
              setMode('local');
            }}
          >
            Return to Main Menu
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('tutto-theme') || 'light';
  });

  const [deviceId] = useState(() => {
    let id = localStorage.getItem('tutto_device_id');
    if (!id) {
      id = uuidv4();
      localStorage.setItem('tutto_device_id', id);
    }
    return id;
  });

  const [showStats, setShowStats] = useState(false);

  // Initialize store once
  useEffect(() => {
    useGameStore.getState().init(deviceId);
  }, [deviceId]);

  // Extract only what App needs to know for routing
  const finished = useGameStore(state => state.finished);
  const currentPlayerIndex = useGameStore(state => state.currentPlayerIndex);
  const players = useGameStore(state => state.players);
  const mode = useGameStore(state => state.mode);

  const hasWinner = finished && players.length > 0;
  const isPlaying = currentPlayerIndex !== null && players.length > 0;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tutto-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  return (
    <>
      <div style={{ position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 100 }}>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" style={{ background: 'var(--card-bg)', boxShadow: 'var(--shadow-md)' }}>
          {theme === 'light' ? <Moon size={24} /> : <Sun size={24} />}
        </button>
      </div>

      <ToastMessage />
      <ReconnectPopup />

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
