import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Scoreboard from './Scoreboard';
import type { GameStore } from '../../store/useGameStore';
import { contrastRatio, LIGHT_SURFACE, DARK_SURFACE, NAME_CONTRAST_TARGET } from '../../utils/contrastColor';

// Mock framer-motion
vi.mock('framer-motion', () => {
  return {
    motion: {
      div: ({ children, ...props }) => {
        const cleanProps = { ...props };
        delete cleanProps.layout;
        delete cleanProps.transition;
        delete cleanProps.initial;
        delete cleanProps.animate;
        delete cleanProps.exit;
        return <div {...cleanProps}>{children}</div>;
      },
    },
    AnimatePresence: ({ children }) => <>{children}</>,
  };
});

describe('Scoreboard Component', () => {
  it('renders translation keys correctly', () => {
    const game = {
      players: [{ name: 'Player 1', score: 100, socketId: 'abc' }],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
      turnTimeRemaining: 30,
      hostId: 'abc'
    };

    render(<Scoreboard game={game as unknown as GameStore} formattedTime="10:00" />);

    expect(screen.getByText('game.currentPlayer')).toBeInTheDocument();
    expect(screen.getByTitle('game.host')).toBeInTheDocument();
    expect(screen.getByText('game.you')).toBeInTheDocument();
    expect(screen.getByText('game.yourScore')).toBeInTheDocument();
    expect(screen.getByText('game.round')).toBeInTheDocument();
    expect(screen.getByText('game.turnTimer')).toBeInTheDocument();
    expect(screen.getAllByText('game.timeSeconds').length).toBe(1);
    expect(screen.getByText('game.time')).toBeInTheDocument();
  });

  it('renders translation keys when disconnected', () => {
    const game = {
      players: [{ name: 'Player 2', score: 100, socketId: 'def', disconnected: true }],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
    };

    render(<Scoreboard game={game as unknown as GameStore} formattedTime="10:00" />);
    expect(screen.getByText('game.disconnected')).toBeInTheDocument();
  });

  it('renders regular score translation when offline', () => {
    const game = {
      players: [{ name: 'Player 1', score: 100 }],
      currentPlayerIndex: 0,
      isOnline: false,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
    };

    render(<Scoreboard game={game as unknown as GameStore} formattedTime="10:00" />);
    expect(screen.getByText('game.score')).toBeInTheDocument();
  });

  it('does not render a win streak badge in the current player panel, even for a high winStreak', () => {
    const game = {
      players: [{ name: 'StreakPlayer', score: 100, socketId: 'abc', winStreak: 5 }],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
    };
    render(<Scoreboard game={game as unknown as GameStore} formattedTime="10:00" />);
    expect(screen.queryByText('🔥 5')).not.toBeInTheDocument();
  });

  // The name used to be painted with a plain inline `color`, which for most
  // player colours is unreadable in one theme or the other (gold is 1.40:1 on
  // the light card). It now carries a per-theme pair that index.css chooses
  // between. Which one wins is cascade, so only e2e can assert that
  // (e2e/styling.spec.ts) — this pins the half jsdom can see: the class is
  // present and both values are set and readable.
  it('paints the current player name through the per-theme contrast pair', () => {
    const game = {
      // Gold: the palette's worst case on a light background.
      players: [{ name: 'Goldie', score: 100, socketId: 'abc', color: '#FFD700' }],
      currentPlayerIndex: 0,
      isOnline: false,
      myName: 'Goldie',
      round: 1,
      winningScore: 1000,
    };

    render(<Scoreboard game={game as unknown as GameStore} formattedTime="10:00" />);

    const name = screen.getByText('Goldie').closest('.player-name') as HTMLElement;
    expect(name, 'the name must carry the class the stylesheet keys on').not.toBeNull();

    const light = name.style.getPropertyValue('--player-name-light');
    const dark = name.style.getPropertyValue('--player-name-dark');
    expect(contrastRatio(light, LIGHT_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(dark, DARK_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    // Gold already clears the target on the dark card, so it survives there
    // untouched — the fit only moves what it has to.
    expect(dark.toUpperCase()).toBe('#FFD700');

    // And no bare inline colour is left behind to fight the stylesheet.
    expect(name.style.color).toBe('');
  });
});
