import React, { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useGameLogic } from './hooks/useGameLogic';
import { useOnlineGame } from './hooks/useOnlineGame';
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

  const [mode, setMode] = useState('local');
  const [showStats, setShowStats] = useState(false);

  const localGame = useGameLogic();
  const onlineGame = useOnlineGame(deviceId);

  const game = mode === 'local' ? localGame : onlineGame;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tutto-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
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
      ) : game.finished && game.winner ? (
        <EndScreen game={game} theme={theme} mode={mode} setMode={setMode} deviceId={deviceId} />
      ) : game.currentPlayerIndex != null && game.currentPlayer ? (
        <Game game={game} />
      ) : (
        <Home game={game} mode={mode} setMode={setMode} onShowStats={() => setShowStats(true)} />
      )}
    </>
  );
}
