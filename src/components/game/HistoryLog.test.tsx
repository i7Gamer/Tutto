import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, it, expect, vi } from 'vitest';
import HistoryLog from './HistoryLog';
import { useGameStore } from '../../store/useGameStore';
import type { HistoryEntry } from '../../types';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
      const cleanProps = { ...props };
      delete cleanProps.layout;
      delete cleanProps.transition;
      delete cleanProps.initial;
      delete cleanProps.animate;
      delete cleanProps.exit;
      return <div {...cleanProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
}));

describe('HistoryLog', () => {
  it('renders empty state message when historyLog is empty', () => {
    useGameStore.setState({ historyLog: [] });
    render(<HistoryLog />);
    expect(screen.getByText('history.empty')).toBeInTheDocument();
  });

  it('renders a skip entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Stop',
      type: 'skip',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.queryByText('history.empty')).not.toBeInTheDocument();
    expect(screen.getByText('history.skip')).toBeInTheDocument();
  });

  it('renders a bust entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'x2',
      type: 'bust',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.bust')).toBeInTheDocument();
  });

  it('renders a fail entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Kniffel',
      type: 'fail',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.fail')).toBeInTheDocument();
  });

  it('renders a standard success entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: '300',
      type: 'success',
      score: 500,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.success')).toBeInTheDocument();
  });

  it('renders a Kleeblatt success entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Kleeblatt',
      type: 'success',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.kleeblatt')).toBeInTheDocument();
  });

  it('renders a Plus_Minus success with deducted players correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Plus_Minus',
      type: 'success',
      score: 1000,
      deductedPlayers: ['Bob', 'Charlie'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.plusMinusDeducted')).toBeInTheDocument();
  });

  // A completed Kleeblatt is a binary instant win, so the engine deliberately
  // records the turn as worth 0 (see calculateNextTurn). The chain message
  // prints that score, so the game-winning turn read as "scored 0 pts".
  it('reports a chain that ended on a completed Kleeblatt as the win it is', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-1',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'success',
      score: 0,
      cards: ['200', 'Kleeblatt'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainKleeblatt')).toBeInTheDocument();
    expect(screen.queryByText('history.chainSuccess')).toBeNull();
  });

  it('still reports an ordinary banked chain with its score', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-2',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'success',
      score: 1500,
      cards: ['200', 'Kniffel'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainSuccess')).toBeInTheDocument();
  });

  it('reports a chain that BUSTED on a Kleeblatt as the loss it is', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-3',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'bust',
      score: 0,
      cards: ['200', 'Kleeblatt'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainBust')).toBeInTheDocument();
  });
});
