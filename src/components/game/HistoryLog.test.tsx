import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import HistoryLog from './HistoryLog';
import { useGameStore } from '../../store/useGameStore';
import type { HistoryEntry } from '../../types';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
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
});
