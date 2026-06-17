import React, { useState, useEffect } from 'react';
import { useGameLogic } from './hooks/useGameLogic';
import Home from './components/Home';
import Game from './components/Game';
import EndScreen from './components/EndScreen';
import { Moon, Sun } from 'lucide-react';
import './index.css';

export default function App() {
  const game = useGameLogic();
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  };

  return (
    <>
      <div style={{ position: 'absolute', top: '1rem', right: '1rem', zIndex: 100 }}>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'light' ? <Moon size={24} /> : <Sun size={24} />}
        </button>
      </div>

      {game.finished && game.winner ? (
        <EndScreen game={game} theme={theme} />
      ) : game.currentPlayerIndex !== null ? (
        <Game game={game} />
      ) : (
        <Home game={game} />
      )}
    </>
  );
}
