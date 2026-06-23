import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';
import { useGameStore } from '../store/useGameStore';

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
  let mockNextTurn;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNextTurn = vi.fn();
    useGameStore.setState({
      currentPlayerIndex: 0,
      currentPlayer: { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
      currentCard: 'x2',
      nextTurn: mockNextTurn,
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
    });
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders crown emoji for the host player in online games', () => {
    useGameStore.setState({ isOnline: true, hostId: 'socket1', myName: 'Alice', socketId: 'socket1' });
    render(<Game />);
    
    // Check for the "You" string, we don't test Scoreboard here directly unless it's rendered,
    // but we can check if 👑 is in the document!
    expect(screen.getAllByText(/👑/).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('game.host').length).toBeGreaterThan(0);
  });

  it('renders "Apply bonus" checkbox for x2 and correctly multiplies score', () => {
    useGameStore.setState({ currentCard: 'x2' });
    render(<Game />);

    // Input a score
    const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(scoreInput, { target: { value: '1000' } });

    // Check the bonus box
    const checkbox = screen.getByLabelText('game.controls.applyBonus');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Submit
    const nextTurnBtn = screen.getByText('game.controls.nextTurn');
    fireEvent.click(nextTurnBtn);

    // Should multiply 1000 * 2 = 2000
    expect(mockNextTurn).toHaveBeenCalledWith(2000, true);
  });

  it('handles applying bonus correctly via checkbox', () => {
    useGameStore.setState({ currentCard: '300' });
    render(<Game />);
    
    // Test for 'Apply bonus' checkbox
    const bonusCheckbox = screen.getByRole('checkbox');
    expect(bonusCheckbox).toBeInTheDocument();
    
    fireEvent.click(bonusCheckbox);
    expect(bonusCheckbox).toBeChecked();
  });

  it('renders flex div structure instead of table for leaderboard to avoid transform bugs', () => {
    const { container } = render(<Game />);
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders "Apply bonus" checkbox for 400 and correctly adds score', () => {
    useGameStore.setState({ currentCard: '400' });
    render(<Game />);

    // Enter a score
    const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(scoreInput, { target: { value: '1000' } });

    // Check the bonus box
    const bonusCheck = screen.getByLabelText(/game.controls.applyBonus/i);
    fireEvent.click(bonusCheck);

    // Submit
    const submitBtn = screen.getByRole('button', { name: /game.controls.nextTurn/i });
    fireEvent.click(submitBtn);

    expect(mockNextTurn).toHaveBeenCalledWith(1400, true);
  });

  it('does not render "Apply bonus" checkbox for normal cards', () => {
    useGameStore.setState({ currentCard: 'Kniffel', currentCardHasInput: false });
    const { unmount } = render(<Game />);
    expect(screen.queryByLabelText('game.controls.applyBonus')).not.toBeInTheDocument();
    unmount();

    useGameStore.setState({ currentCard: 'Feuerwerk', currentCardHasInput: true });
    render(<Game />);
    expect(screen.queryByLabelText('game.controls.applyBonus')).not.toBeInTheDocument();
  });

  it('automatically advances turn after 5 seconds on Stop card in online game', () => {
    useGameStore.setState({ currentCard: 'Stop' });
    render(<Game />);

    expect(mockNextTurn).not.toHaveBeenCalled();

    // Fast-forward 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockNextTurn).toHaveBeenCalledWith(0, false);
  });

  it('does NOT automatically advance turn if it is NOT the players turn', () => {
    useGameStore.setState({ currentCard: 'Stop', myName: 'Bob', socketId: 'socket2' });
    
    render(<Game />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockNextTurn).not.toHaveBeenCalled();
  });

  it('does NOT automatically advance turn for non-Stop cards in online game', () => {
    useGameStore.setState({ currentCard: 'Feuerwerk' });
    render(<Game />);

    // Fast-forward 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockNextTurn).not.toHaveBeenCalled();
  });

  it('sends isSuccess=false when manually submitting 0 points for x2', () => {
    useGameStore.setState({ currentCard: 'x2' });
    render(<Game />);

    // Do not enter a score (defaults to 0) or explicitly enter 0
    const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(scoreInput, { target: { value: '0' } });

    const submitBtn = screen.getByRole('button', { name: /game.controls.nextTurn/i });
    fireEvent.click(submitBtn);

    // Score is 0, so it's a bust (isSuccess = false)
    expect(mockNextTurn).toHaveBeenCalledWith(0, false);
  });

  it('sends isSuccess=false when manually submitting 0 points for Feuerwerk', () => {
    useGameStore.setState({ currentCard: 'Feuerwerk' });
    render(<Game />);

    const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(scoreInput, { target: { value: '0' } });

    const submitBtn = screen.getByRole('button', { name: /game.controls.nextTurn/i });
    fireEvent.click(submitBtn);

    expect(mockNextTurn).toHaveBeenCalledWith(0, false);
  });

  it('sends isSuccess=true when manually submitting >0 points for Feuerwerk', () => {
    useGameStore.setState({ currentCard: 'Feuerwerk' });
    render(<Game />);

    const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
    fireEvent.change(scoreInput, { target: { value: '500' } });

    const submitBtn = screen.getByRole('button', { name: /game.controls.nextTurn/i });
    fireEvent.click(submitBtn);

    expect(mockNextTurn).toHaveBeenCalledWith(500, true);
  });

  it('hides Roll Dice button when diceMode is physical', () => {
    useGameStore.setState({ diceMode: 'physical' });
    render(<Game />);

    const rollDiceButton = screen.queryByText(/game.controls.rollDice/i);
    expect(rollDiceButton).toBeNull();
    
    // Test that 'OR TYPE SCORE' is also hidden
    const typeScoreDivider = screen.queryByText('game.controls.orTypeScore');
    expect(typeScoreDivider).toBeNull();
  });

  it('shows Roll Dice button when diceMode is digital', () => {
    useGameStore.setState({ diceMode: 'digital' });
    render(<Game />);

    const rollDiceButton = screen.getByText(/game.controls.rollDice/i);
    expect(rollDiceButton).toBeTruthy();
  });

  it('plays buzzer sound when Stop card is drawn locally or online', async () => {
    act(() => {
      useGameStore.setState({ currentCard: 'Stop' });
    });
    render(<Game />);
    
    expect(await import('../utils/soundEffects').then(m => m.playBuzzer)).toHaveBeenCalled();
    
    vi.clearAllMocks();

    act(() => {
      useGameStore.setState({ currentCard: 'Stop', isOnline: false });
    });
    render(<Game />);

    expect(await import('../utils/soundEffects').then(m => m.playBuzzer)).toHaveBeenCalled();
  });

  it('triggers animation and sound on consecutive Feuerwerk draws', async () => {
    const playSuccess = await import('../utils/soundEffects').then(m => m.playSuccess);
    const confetti = await import('canvas-confetti').then(m => m.default);

    act(() => {
      useGameStore.setState({ currentCard: 'Feuerwerk' });
    });
    
    const { rerender } = render(<Game />);
    
    // First draw
    expect(playSuccess).toHaveBeenCalledTimes(1);
    expect(confetti).toHaveBeenCalledTimes(1);
    
    vi.clearAllMocks();

    // Re-render with same card should re-trigger because of useEffect dependency
    act(() => {
      useGameStore.setState({ currentCard: null });
    });
    
    rerender(<Game />);
    
    act(() => {
      useGameStore.setState({ currentCard: 'Feuerwerk' });
    });
    
    rerender(<Game />);
    
    expect(playSuccess).toHaveBeenCalledTimes(1);
    expect(confetti).toHaveBeenCalledTimes(1);
  });

  it('renders translated strings', () => {
    useGameStore.setState({
      winningScore: 5000,
      players: [
        { name: 'Bob', socketId: 'socket1', score: 0, position: 1, disconnected: true }
      ],
      sortedPlayers: [
        { name: 'Bob', socketId: 'socket1', score: 0, position: 1, disconnected: true }
      ]
    });
    render(<Game />);

    expect(screen.getAllByText('game.leaderboard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('game.pos').length).toBeGreaterThan(0);
    expect(screen.getAllByText('game.player').length).toBeGreaterThan(0);
    expect(screen.getAllByText('game.score').length).toBeGreaterThan(0);
    expect(screen.getAllByText('game.disconnected').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/game.goalPrefix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/game.goalSuffix/).length).toBeGreaterThan(0);
  });
});
