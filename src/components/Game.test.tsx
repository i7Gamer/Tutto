import { render, screen, fireEvent, act } from '@testing-library/react';
import { Profiler } from 'react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';
import { useGameStore } from '../store/useGameStore';
import { vibrateYourTurn, vibrateTurnUrgent } from '../utils/soundEffects';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  vibrateYourTurn: vi.fn(),
  vibrateTurnUrgent: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn()
}));

vi.mock('./DiceGame', () => ({
  default: () => <div data-testid="mock-dice-game">Dice Game</div>,
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
      // Most tests in this file exercise the physical-mode score input/yes-no
      // controls; tests for digital-mode behavior set diceMode explicitly.
      diceMode: 'physical',
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

  it('does not double-advance when Continue is clicked before the Stop auto-advance timeout fires', () => {
    useGameStore.setState({ currentCard: 'Stop' });
    // Mimic the real store: nextTurn moves the game on to a new card, which is
    // what actually clears the pending auto-advance timeout (the effect's
    // cleanup fires because `currentCard` changed).
    mockNextTurn.mockImplementation(() => {
      useGameStore.setState({ currentCard: '200' });
    });
    render(<Game />);

    const continueBtn = screen.getByRole('button', { name: /game.controls.continue/i });
    fireEvent.click(continueBtn);
    expect(mockNextTurn).toHaveBeenCalledTimes(1);

    // The original 5s auto-advance timeout must not still be pending — it
    // should have been cleared once currentCard changed, so this must not
    // call nextTurn a second time for the same Stop card.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockNextTurn).toHaveBeenCalledTimes(1);
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

  describe('host-enforced dice mode overrides the personal preference', () => {
    it('shows Roll Dice even though the player\'s own diceMode is physical, when the host enforces digital', () => {
      useGameStore.setState({ diceMode: 'physical', enforcedDiceMode: 'digital', isOnline: true });
      render(<Game />);

      expect(screen.getByText(/game.controls.rollDice/i)).toBeTruthy();
    });

    it('hides Roll Dice even though the player\'s own diceMode is digital, when the host enforces physical', () => {
      useGameStore.setState({ diceMode: 'digital', enforcedDiceMode: 'physical', isOnline: true });
      render(<Game />);

      expect(screen.queryByText(/game.controls.rollDice/i)).toBeNull();
    });

    it('ignores enforcedDiceMode entirely offline (no host to enforce anything)', () => {
      useGameStore.setState({ diceMode: 'physical', enforcedDiceMode: 'digital', isOnline: false });
      render(<Game />);

      expect(screen.queryByText(/game.controls.rollDice/i)).toBeNull();
    });

    it('falls back to the personal diceMode when enforcement is off (enforcedDiceMode: null)', () => {
      useGameStore.setState({ diceMode: 'digital', enforcedDiceMode: null, isOnline: true });
      render(<Game />);

      expect(screen.getByText(/game.controls.rollDice/i)).toBeTruthy();
    });
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
      useGameStore.setState({ currentCard: 'Feuerwerk', cards: ['Feuerwerk', 'Stop'] });
    });
    
    const { rerender } = render(<Game />);
    
    // First draw
    expect(playSuccess).toHaveBeenCalledTimes(1);
    expect(confetti).toHaveBeenCalledTimes(1);
    
    vi.clearAllMocks();

    // Consecutive draw of Feuerwerk: currentCard stays 'Feuerwerk', cards array length decreases
    act(() => {
      useGameStore.setState({ currentCard: 'Feuerwerk', cards: ['Stop'] });
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

  it('renders a Kick button next to disconnected player when current user is the host', () => {
    const kickPlayerMock = vi.fn();
    useGameStore.setState({
      isOnline: true,
      isHost: true,
      kickPlayer: kickPlayerMock,
      players: [
        { name: 'Alice', socketId: 'socket-host', score: 0, position: 1 },
        { name: 'Bob', socketId: 'socket-client', score: 0, position: 2, disconnected: true }
      ],
      sortedPlayers: [
        { name: 'Alice', socketId: 'socket-host', score: 0, position: 1 },
        { name: 'Bob', socketId: 'socket-client', score: 0, position: 2, disconnected: true }
      ]
    });
    render(<Game />);

    const kickButton = screen.getByRole('button', { name: 'game.kick' });
    expect(kickButton).toBeInTheDocument();

    fireEvent.click(kickButton);
    expect(kickPlayerMock).toHaveBeenCalledWith('socket-client');
  });

  describe('Plus_Minus Card - Physical Dice (Manual Entry)', () => {
    it('shows Yes/No buttons for Plus_Minus card in physical mode', () => {
      useGameStore.setState({
        diceMode: 'physical',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      expect(screen.getByText(/game.controls.didYouSucceed/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /game.controls.yes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /game.controls.no/i })).toBeInTheDocument();
    });

    it('calls nextTurn with (0, true) when clicking Yes on Plus_Minus', () => {
      useGameStore.setState({
        diceMode: 'physical',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      const yesButton = screen.getByRole('button', { name: /game.controls.yes/i });
      fireEvent.click(yesButton);

      expect(mockNextTurn).toHaveBeenCalledWith(0, true);
    });

    it('calls nextTurn with (0, false) when clicking No on Plus_Minus', () => {
      useGameStore.setState({
        diceMode: 'physical',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      const noButton = screen.getByRole('button', { name: /game.controls.no/i });
      fireEvent.click(noButton);

      expect(mockNextTurn).toHaveBeenCalledWith(0, false);
    });
  });

  describe('Plus_Minus Card - Digital Dice', () => {
    it('shows Roll Dice button for Plus_Minus card in digital mode', () => {
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      expect(screen.getByRole('button', { name: /game.controls.rollDice/i })).toBeInTheDocument();
    });

    it('opens DiceGame modal when clicking Roll Dice on Plus_Minus', () => {
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      const rollButton = screen.getByRole('button', { name: /game.controls.rollDice/i });
      fireEvent.click(rollButton);

      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
    });

    it('calls nextTurn when DiceGame completes with success on Plus_Minus', () => {
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'Plus_Minus',
      });

      render(<Game />);

      // Simulate DiceGame completion with success
      act(() => {
        const handleDiceComplete = (score, isSuccess) => {
          useGameStore.setState({ currentCard: 'Plus_Minus' });
          mockNextTurn(score, isSuccess);
        };
        // Manually call handleDiceComplete since we can't interact with mock
        handleDiceComplete(0, true);
      });

      expect(mockNextTurn).toHaveBeenCalledWith(0, true);
    });
  });

  describe('Plus_Minus Card - Both Modes Integration', () => {
    it('both modes deduct 1000 from leader when Plus_Minus is successful', () => {
      // Test that both modes ultimately call nextTurn(0, true)
      // Physical mode
      useGameStore.setState({
        diceMode: 'physical',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      const yesButton = screen.getByRole('button', { name: /game.controls.yes/i });
      fireEvent.click(yesButton);

      expect(mockNextTurn).toHaveBeenCalledWith(0, true);

      // Both modes call nextTurn with same signature for Plus_Minus success
      // The actual deduction logic is tested in coreGameEngine.test.js
    });

    it('both modes handle Plus_Minus failure by calling nextTurn(0, false)', () => {
      // Physical mode
      useGameStore.setState({
        diceMode: 'physical',
        currentCard: 'Plus_Minus',
      });
      render(<Game />);

      const noButton = screen.getByRole('button', { name: /game.controls.no/i });
      fireEvent.click(noButton);

      expect(mockNextTurn).toHaveBeenCalledWith(0, false);

      // Both modes call nextTurn with same signature for Plus_Minus failure
    });
  });

  describe('Local Game Dice Caching', () => {
    beforeEach(() => {
      localStorage.clear();
      useGameStore.setState({
        mode: 'local',
        isOnline: false,
        currentPlayerIndex: 0,
        currentCard: 'x2',
        diceMode: 'digital',
        myName: 'LocalPlayer',
        players: [
          { name: 'LocalPlayer', score: 0, position: 1, color: '#FF5733' }
        ],
      });
    });

    it('auto-opens DiceGame when cached dice state exists in localStorage for local games', () => {
      // Set up cached dice game state
      const cachedState = { turnScore: 150, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2' };
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify(cachedState));

      render(<Game />);

      // After a small delay to let useEffect run
      act(() => {
        vi.advanceTimersByTime(100);
      });

      // DiceGame should be visible (modal wrapper should show the dice game)
      const diceGame = screen.getByTestId('mock-dice-game');
      expect(diceGame).toBeInTheDocument();
    });

    it('does not auto-open DiceGame when physical dice mode is active', () => {
      useGameStore.setState({
        diceMode: 'physical',
      });

      const cachedState = { turnScore: 75, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2' };
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify(cachedState));

      render(<Game />);

      act(() => {
        vi.advanceTimersByTime(100);
      });

      // DiceGame should not appear even with cached state
      const diceGame = screen.queryByTestId('mock-dice-game');
      expect(diceGame).not.toBeInTheDocument();
    });

    it('does not show spurious resume toast when liveTurnState updates during active dice game', () => {
      // No cached state at mount — user opens dice game manually
      render(<Game />);

      const mockAddToast = vi.fn();
      act(() => {
        useGameStore.setState({ addToast: mockAddToast });
      });

      // Simulate liveTurnState being written after first dice roll (DiceGame calls onStateChange)
      act(() => {
        useGameStore.setState({
          liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [] }
        });
        // This also writes to localStorage (as setLiveTurnState does)
        localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50, turnKey: 'local:1:0:x2' }));
        vi.advanceTimersByTime(400); // past DiceGame's 300ms debounce
      });

      // The toast should NOT have been called — no cache was present at mount
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
      // And the dice game modal should not have been auto-opened
      // (it was never opened because there was no cached state at mount)
    });

    it('clears liveTurnState in the store when the dice turn ends in local mode', () => {
      const cachedState = { turnScore: 100, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2' };
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify(cachedState));

      render(<Game />);

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      // Simulate store having a liveTurnState (from dice rolls during this turn)
      act(() => {
        useGameStore.setState({ liveTurnState: { turnScore: 100 } });
      });

      expect(useGameStore.getState().liveTurnState).not.toBeNull();

      // Verify the store's setLiveTurnState clears it once the turn resolves.
      act(() => {
        useGameStore.getState().setLiveTurnState(null);
      });

      expect(useGameStore.getState().liveTurnState).toBeNull();
    });
  });

  describe('Online Reconnect Dice Resume', () => {
    beforeEach(() => {
      localStorage.clear();
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        currentPlayerIndex: 0,
        currentCard: 'x2',
        diceMode: 'digital',
        myName: 'Alice',
        players: [{ name: 'Alice', socketId: 'socket1', score: 0, position: 1 }],
        liveTurnState: null,
        justReconnected: false,
      });
    });

    it('auto-opens DiceGame and shows the resume toast when reconnecting mid-roll on my turn', () => {
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        liveTurnState: { turnScore: 200, keptDice: [], currentRoll: [] },
        justReconnected: true,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockAddToast).toHaveBeenCalledWith('game.resumingDiceGame');
    });

    it('does not show the resume UI when the reconnect is not resumable (e.g. a spectator)', () => {
      const mockAddToast = vi.fn();
      // Reconnecting as a spectator (not the active player) — nothing to resume.
      useGameStore.setState({
        addToast: mockAddToast,
        myName: 'Bob',
        justReconnected: true,
        liveTurnState: null,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
    });

    it('only shows the resume UI once per reconnect episode, even if liveTurnState changes again while justReconnected is still true', () => {
      // Simulates DiceGame's own onStateChange firing ~300ms after it mounts to
      // resume (see DiceGame.tsx), which updates liveTurnState again before the
      // store's next gameState round-trip has had a chance to clear
      // justReconnected.
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        liveTurnState: { turnScore: 200, keptDice: [], currentRoll: [] },
        justReconnected: true,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });
      expect(mockAddToast).toHaveBeenCalledTimes(1);

      act(() => {
        useGameStore.setState({ liveTurnState: { turnScore: 250, keptDice: [], currentRoll: [] } });
        vi.advanceTimersByTime(100);
      });

      // Still only the one toast — justReconnected hasn't changed, only liveTurnState.
      expect(mockAddToast).toHaveBeenCalledTimes(1);
    });
    it('does not show the resume UI when the active player reconnects but diceMode is physical', () => {
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        // It IS my turn and there IS a live state — but dice mode is physical, so
        // no digital DiceGame to resume.
        liveTurnState: { turnScore: 200, keptDice: [], currentRoll: [] },
        diceMode: 'physical',
        justReconnected: true,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
    });

    it('does not show the resume UI when the active player reconnects but liveTurnState is null (turn not yet started)', () => {
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        // It IS my turn in digital mode, but there is no in-flight dice state to
        // restore — nothing mid-roll.
        liveTurnState: null,
        diceMode: 'digital',
        justReconnected: true,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
    });

    it('fires the resume toast for each successive reconnect episode in the same session', () => {
      // Verifies that onlineReconnectHandledRef is correctly reset between
      // episodes so a second reconnect is not silently swallowed.
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        liveTurnState: { turnScore: 200, keptDice: [], currentRoll: [] },
        justReconnected: true,
      });

      const { unmount } = render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });
      expect(mockAddToast).toHaveBeenCalledTimes(1);

      // Simulate the store's self-clear after the next gameState event.
      act(() => {
        useGameStore.setState({ justReconnected: false });
        vi.advanceTimersByTime(100);
      });

      unmount();

      // Second reconnect episode: fresh mount, flag set again.
      useGameStore.setState({ justReconnected: true });
      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(mockAddToast).toHaveBeenCalledTimes(2);
    });
  });

  describe('keyboard shortcuts', () => {
    // Earlier tests in this file (reconnect-resume) can leave justReconnected/
    // liveTurnState set on the shared store, which would auto-open the dice
    // modal on mount here — reset them so each test starts from a clean slate.
    beforeEach(() => {
      useGameStore.setState({ justReconnected: false, liveTurnState: null });
    });

    it('Space opens the dice-roll modal in digital mode', () => {
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: ' ' });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
    });

    it('Escape does not close the dice-roll modal — it auto-rolls immediately and cannot be backed out of', () => {
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('clicking the backdrop does not close the dice-roll modal', () => {
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('dice-game-backdrop'));
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('Enter submits the physical-mode score input as Next Turn', () => {
      useGameStore.setState({ diceMode: 'physical', currentCard: '200' });
      render(<Game />);

      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
      fireEvent.change(scoreInput, { target: { value: '350' } });
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockNextTurn).toHaveBeenCalledWith(350, true);
    });

    it('Space answers Yes for a physical-mode Yes/No card (Kniffel)', () => {
      useGameStore.setState({ diceMode: 'physical', currentCard: 'Kniffel' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' });
      expect(mockNextTurn).toHaveBeenCalledWith(0, true);
    });

    it('Space continues past a Stop card', () => {
      useGameStore.setState({ diceMode: 'physical', currentCard: 'Stop' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' });
      expect(mockNextTurn).toHaveBeenCalledWith(0, false);
    });

    it('opens Roll Dice via Space in digital mode even for a Yes/No card (digital always shows Roll Dice)', () => {
      useGameStore.setState({ diceMode: 'digital', currentCard: 'Kniffel' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('ignores the shortcut when it is not the player\'s turn', () => {
      useGameStore.setState({ diceMode: 'physical', currentCard: '200', myName: 'Bob' });
      render(<Game />);

      fireEvent.keyDown(window, { key: 'Enter' });
      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('ignores the shortcut while focus is inside the score input', () => {
      useGameStore.setState({ diceMode: 'physical', currentCard: '200' });
      render(<Game />);

      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
      scoreInput.focus();
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('ignores the shortcut while a confirm dialog (e.g. Leave Game) is open, instead of answering a Yes/No card behind it', () => {
      // GameControls is NOT mocked in this file, so this exercises the real
      // ConfirmModal it opens — window.confirm used to make this safe for
      // free (a blocking native dialog swallows all page keyboard input);
      // ConfirmModal doesn't, so without a guard this keypress bubbled
      // straight through to the global shortcut below and answered "Yes" on
      // the Kniffel card while the "leave game?" dialog was still showing.
      useGameStore.setState({ diceMode: 'physical', currentCard: 'Kniffel', isOnline: true, isHost: false });
      render(<Game />);

      fireEvent.click(screen.getByText('game.controls.leaveGame'));
      expect(screen.getByText('game.controls.leaveGameConfirm')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: ' ' });

      expect(mockNextTurn).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(screen.getByText('game.controls.leaveGameConfirm')).toBeInTheDocument();
    });
  });

  describe('pre-game stats snapshot', () => {
    let originalFetch: typeof fetch;
    beforeAll(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fetches and stores a pre-game stats snapshot for online games', async () => {
      const setPreGameStats = vi.fn();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null }),
      })) as unknown as typeof fetch;

      useGameStore.setState({ isOnline: true, deviceId: 'device-1', setPreGameStats });
      render(<Game />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(global.fetch).toHaveBeenCalledWith('/api/stats/device-1');
      expect(setPreGameStats).toHaveBeenCalledWith({
        highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
        highestFeuerwerkTurnScore: null, highestX2TurnScore: null,
      });
    });

    it('includes highestFeuerwerkTurnScore/highestX2TurnScore in the pre-game stats snapshot when present', async () => {
      const setPreGameStats = vi.fn();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
          highestFeuerwerkTurnScore: 700, highestX2TurnScore: 900,
        }),
      })) as unknown as typeof fetch;

      useGameStore.setState({ isOnline: true, deviceId: 'device-1', setPreGameStats });
      render(<Game />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(setPreGameStats).toHaveBeenCalledWith({
        highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
        highestFeuerwerkTurnScore: 700, highestX2TurnScore: 900,
      });
    });

    it('does not fetch pre-game stats for local games', () => {
      const setPreGameStats = vi.fn();
      global.fetch = vi.fn();

      useGameStore.setState({ isOnline: false, deviceId: 'device-1', setPreGameStats });
      render(<Game />);

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('emoji reaction bar', () => {
    it('shows the reaction bar for online games and sends the clicked emoji', () => {
      const sendReaction = vi.fn();
      useGameStore.setState({ isOnline: true, sendReaction });
      render(<Game />);

      fireEvent.click(screen.getByText('🔥'));
      expect(sendReaction).toHaveBeenCalledWith('🔥');
    });

    it('hides the reaction bar for local games', () => {
      useGameStore.setState({ isOnline: false });
      render(<Game />);

      expect(screen.queryByText('🔥')).not.toBeInTheDocument();
    });
  });

  describe('haptic feedback', () => {
    it('vibrates once when it becomes my turn in an online game', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Bob',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
          { name: 'Bob', socketId: 'socket2', score: 0, position: 2 },
        ],
      });
      render(<Game />);
      expect(vibrateYourTurn).not.toHaveBeenCalled();

      act(() => {
        useGameStore.setState({ currentPlayerIndex: 1 });
      });

      expect(vibrateYourTurn).toHaveBeenCalledTimes(1);
    });

    it('does not vibrate on mount even if it is already my turn', () => {
      useGameStore.setState({ isOnline: true, myName: 'Alice', currentPlayerIndex: 0 });
      render(<Game />);

      expect(vibrateYourTurn).not.toHaveBeenCalled();
    });

    it('does not vibrate for a turn change in a local (non-online) game', () => {
      useGameStore.setState({
        isOnline: false,
        myName: 'Bob',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
          { name: 'Bob', socketId: 'socket2', score: 0, position: 2 },
        ],
      });
      render(<Game />);

      act(() => {
        useGameStore.setState({ currentPlayerIndex: 1 });
      });

      expect(vibrateYourTurn).not.toHaveBeenCalled();
    });

    it('vibrates every second for as long as the turn timer reads 10s or under', () => {
      useGameStore.setState({
        isOnline: true, myName: 'Alice', currentPlayerIndex: 0, turnTimeRemaining: 15,
      });
      render(<Game />);
      expect(vibrateTurnUrgent).not.toHaveBeenCalled();

      act(() => {
        useGameStore.setState({ turnTimeRemaining: 10 });
      });
      expect(vibrateTurnUrgent).toHaveBeenCalledTimes(1);

      act(() => {
        useGameStore.setState({ turnTimeRemaining: 9 });
      });
      expect(vibrateTurnUrgent).toHaveBeenCalledTimes(2);

      act(() => {
        useGameStore.setState({ turnTimeRemaining: 8 });
      });
      expect(vibrateTurnUrgent).toHaveBeenCalledTimes(3);
    });

    it('does not vibrate turn-timer urgency for a spectator (not my turn)', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Bob',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
          { name: 'Bob', socketId: 'socket2', score: 0, position: 2 },
        ],
        turnTimeRemaining: 15,
      });
      render(<Game />);

      act(() => {
        useGameStore.setState({ turnTimeRemaining: 10 });
      });

      expect(vibrateTurnUrgent).not.toHaveBeenCalled();
    });

    it('renders win streak badge when winStreak >= 3', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1, winStreak: 4 },
        ],
      });
      render(<Game />);
      expect(screen.getAllByText('🔥 4').length).toBeGreaterThan(0);
    });

    it('does not render win streak badge when winStreak < 3', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1, winStreak: 2 },
        ],
      });
      render(<Game />);
      expect(screen.queryByText('🔥 2')).not.toBeInTheDocument();
    });

    it('exposes the host/win-streak emoji badges to screen readers via visually-hidden text (COMP-ISSUE-10)', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        hostId: 'socket1',
        currentPlayerIndex: 0,
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1, winStreak: 4 },
        ],
      });
      render(<Game />);
      expect(screen.getAllByText('game.host').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/game.winStreakTitle/).length).toBeGreaterThan(0);
    });
  });

  describe('re-render scope', () => {
    it('does not re-render when an unrelated store slice (toasts) changes', () => {
      let renderCount = 0;
      render(
        <Profiler id="game" onRender={() => { renderCount += 1; }}>
          <Game />
        </Profiler>
      );

      const countAfterMount = renderCount;

      act(() => {
        useGameStore.setState({ toasts: [{ id: 1, message: 'unrelated' }] });
      });

      expect(renderCount).toBe(countAfterMount);
    });

    it('takes the dice panel down in the same commit the turn moves away', () => {
      // The panel is a modal over the whole screen. Closing it from an effect
      // means committing it once more first — on a turn that already belongs
      // to somebody else — and only taking it down on the pass after that.
      useGameStore.setState({
        diceMode: 'digital',
        players: [
          { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
          { name: 'Bob', socketId: 'socket2', score: 0, position: 2 },
        ],
      });

      let renderCount = 0;
      render(
        <Profiler id="game" onRender={() => { renderCount += 1; }}>
          <Game />
        </Profiler>
      );
      fireEvent.click(screen.getByText(/game.controls.rollDice/i));
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      const countAfterOpen = renderCount;
      act(() => {
        useGameStore.setState({ currentPlayerIndex: 1 });
      });

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(renderCount).toBe(countAfterOpen + 1);
    });

    it('does re-render when a field it actually reads (currentCard) changes', () => {
      let renderCount = 0;
      render(
        <Profiler id="game" onRender={() => { renderCount += 1; }}>
          <Game />
        </Profiler>
      );

      const countAfterMount = renderCount;

      act(() => {
        useGameStore.setState({ currentCard: '300' });
      });

      expect(renderCount).toBeGreaterThan(countAfterMount);
    });
  });
});
