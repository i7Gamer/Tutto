import React, { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useGameStore } from './store/useGameStore';
import Home from './components/Home';
import Game from './components/Game';
import EndScreen from './components/EndScreen';
import Statistics from './components/Statistics';
import './index.css';

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
