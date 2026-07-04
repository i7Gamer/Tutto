import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Scoreboard from './Scoreboard';

// Mock framer-motion
vi.mock('framer-motion', () => {
  return {
    motion: {
      div: ({ children, ...props }) => <div {...props}>{children}</div>,
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

    render(<Scoreboard game={game} formattedTime="10:00" />);

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

    render(<Scoreboard game={game} formattedTime="10:00" />);
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

    render(<Scoreboard game={game} formattedTime="10:00" />);
    expect(screen.getByText('game.score')).toBeInTheDocument();
  });

  it('renders active emoji reactions with the sender name as a tooltip', () => {
    const game = {
      players: [{ name: 'Player 1', score: 100 }],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
      reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }],
    };

    render(<Scoreboard game={game} formattedTime="10:00" />);
    const reaction = screen.getByText('🔥');
    expect(reaction).toBeInTheDocument();
    expect(reaction).toHaveAttribute('title', 'Alice');
  });

  it('renders nothing extra when there are no reactions', () => {
    const game = {
      players: [{ name: 'Player 1', score: 100 }],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
      reactions: [],
    };

    render(<Scoreboard game={game} formattedTime="10:00" />);
    expect(screen.queryByText('🔥')).not.toBeInTheDocument();
  });
});
