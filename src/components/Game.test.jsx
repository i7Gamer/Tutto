import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn()
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn()
}));

vi.mock('./DiceGame', () => ({
  default: () => <div data-testid="mock-dice-game">Dice Game</div>
}));

describe('Game Component Integration', () => {
  let mockGame;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGame = {
      currentPlayerIndex: 0,
      currentPlayer: { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
      currentCard: 'x2',
      nextTurn: vi.fn(),
      isOnline: true,
      socketId: 'socket1',
      hostId: 'socket1',
      myName: 'Alice',
      winningScore: 6000,
      currentCardHasInput: true,
      currentCardHasYesNo: false,
      players: [
        { name: 'Alice', socketId: 'socket1', score: 0, position: 1 }
      ],
      sortedPlayers: [
        { name: 'Alice', socketId: 'socket1', score: 0, position: 1 }
      ]
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders "Apply bonus" checkbox for x2 and correctly multiplies score', () => {
    mockGame.currentCard = 'x2';
    render(<Game game={mockGame} />);

    // Enter a score
    const scoreInput = screen.getByPlaceholderText('Points (if no dice used)');
    fireEvent.change(scoreInput, { target: { value: '1000' } });

    // Check the bonus box
    const checkbox = screen.getByLabelText('Apply bonus');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Submit
    const nextTurnBtn = screen.getByText('Next Turn');
    fireEvent.click(nextTurnBtn);

    // Should multiply 1000 * 2 = 2000
    expect(mockGame.nextTurn).toHaveBeenCalledWith(2000, false);
  });

  it('renders "Apply bonus" checkbox for 400 and correctly adds score', () => {
    mockGame.currentCard = '400';
    render(<Game game={mockGame} />);

    // Enter a score
    const scoreInput = screen.getByPlaceholderText('Points (if no dice used)');
    fireEvent.change(scoreInput, { target: { value: '1000' } });

    // Check the bonus box
    const checkbox = screen.getByLabelText('Apply bonus');
    fireEvent.click(checkbox);

    // Submit
    const nextTurnBtn = screen.getByText('Next Turn');
    fireEvent.click(nextTurnBtn);

    // Should add 1000 + 400 = 1400
    expect(mockGame.nextTurn).toHaveBeenCalledWith(1400, false);
  });

  it('does not render "Apply bonus" checkbox for normal cards', () => {
    mockGame.currentCard = 'Kniffel'; // No manual input anyway
    mockGame.currentCardHasInput = false;
    const { unmount } = render(<Game game={mockGame} />);
    expect(screen.queryByLabelText('Apply bonus')).not.toBeInTheDocument();
    unmount();

    mockGame.currentCard = 'Feuerwerk'; // Has input but no manual bonus application
    mockGame.currentCardHasInput = true;
    render(<Game game={mockGame} />);
    expect(screen.queryByLabelText('Apply bonus')).not.toBeInTheDocument();
  });

  it('automatically advances turn after 5 seconds on Stop card in online game', () => {
    mockGame.currentCard = 'Stop';
    mockGame.currentCardHasInput = false;
    mockGame.isOnline = true;
    mockGame.socketId = 'socket1'; // It's Alice's turn
    
    render(<Game game={mockGame} />);

    // Initially nextTurn is not called
    expect(mockGame.nextTurn).not.toHaveBeenCalled();

    // Advance 4.9 seconds
    act(() => {
      vi.advanceTimersByTime(4900);
    });
    expect(mockGame.nextTurn).not.toHaveBeenCalled();

    // Advance past 5 seconds
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(mockGame.nextTurn).toHaveBeenCalledWith(0, false);
  });

  it('does NOT automatically advance turn if it is NOT the players turn', () => {
    mockGame.currentCard = 'Stop';
    mockGame.currentCardHasInput = false;
    mockGame.isOnline = true;
    mockGame.myName = 'Bob'; // Not Alice's turn
    mockGame.socketId = 'socket2'; // Someone else's turn
    
    render(<Game game={mockGame} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockGame.nextTurn).not.toHaveBeenCalled();
  });

  it('does NOT automatically advance turn in a local game', () => {
    mockGame.currentCard = 'Stop';
    mockGame.currentCardHasInput = false;
    mockGame.isOnline = false; // Local game
    mockGame.socketId = 'socket1';
    
    render(<Game game={mockGame} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockGame.nextTurn).not.toHaveBeenCalled();
  });
});
