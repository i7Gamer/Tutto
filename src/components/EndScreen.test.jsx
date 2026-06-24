import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import EndScreen from './EndScreen';
import { useGameStore } from '../store/useGameStore';

describe('EndScreen Component', () => {
  beforeEach(() => {
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000, position: 1 },
        { name: 'Bob', score: 5000, position: 2 }
      ],
      sortedPlayers: [
        { name: 'Alice', score: 10000, position: 1 },
        { name: 'Bob', score: 5000, position: 2 }
      ],
      round: 10,
      winningScore: 6000
    });
  });

  it('renders flex div structure instead of table to avoid transform bugs', () => {
    const { container } = render(<EndScreen />);
    
    // Ensure there is no table element, only divs
    expect(container.querySelector('table')).toBeNull();
    
    // Ensure 'Game Statistics' title is rendered
    expect(container.textContent).toContain('end.gameStats');
  });

  it('keeps the same winner and statistics even if the actual winner is removed from the store later', () => {
    const { getByText, queryByText } = render(<EndScreen />);

    // Initially, Alice is the winner
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Simulate Alice leaving the game and being removed from the store's players array
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Bob', score: 5000, position: 2 }
        ]
      });
    });

    // Bob should NOT become the winner, Alice should remain the winner
    expect(getByText('end.winner Alice')).toBeInTheDocument();
    expect(queryByText('end.winner Bob')).toBeNull();
  });
});
