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

  it('assigns correct position values to sorted players', () => {
    useGameStore.setState({
      players: [
        { name: 'Charlie', score: 3000 },
        { name: 'Alice', score: 10000 },
        { name: 'Bob', score: 5000 }
      ]
    });
    const { getByText } = render(<EndScreen />);
    
    // The EndScreen component should render the positions based on sorting by score
    expect(getByText('1.')).toBeInTheDocument();
    expect(getByText('2.')).toBeInTheDocument();
    expect(getByText('3.')).toBeInTheDocument();
  });

  it('assigns tied positions when players have equal scores', () => {
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000 },
        { name: 'Bob', score: 10000 },
        { name: 'Charlie', score: 5000 }
      ]
    });
    const { getAllByText, queryByText } = render(<EndScreen />);

    expect(getAllByText('1.')).toHaveLength(2);
    expect(queryByText('2.')).toBeNull();
    expect(queryByText('3.')).toBeInTheDocument();
  });

  it('does not render chart section when chartLabels is empty', () => {
    useGameStore.setState({ chartLabels: [] });
    const { container } = render(<EndScreen />);
    // Since we don't have a specific test ID, we can check if a canvas element exists (the chart uses canvas)
    expect(container.querySelector('canvas')).toBeNull();
  });
});
