import { render, screen, fireEvent, act } from '@testing-library/react';
import { Profiler } from 'react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';
import { useGameStore, _resetTimersForTests } from '../store/useGameStore';
import { MAX_CHAIN_CARDS } from '../types';
import { STOP_CARD_AUTO_CONTINUE_MS, CARD_FLIP_MS } from '../utils/uiTimings';
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

// The mock stands in for the whole dice panel, but it must still be able to
// DO the one thing the panel exists to do -- report a finished turn through
// onComplete. Without that, a test could only call a handler it wrote itself.
const diceComplete = vi.hoisted(() => (
  { score: 0, isSuccess: true, summary: undefined as unknown }
));
vi.mock('./DiceGame', () => ({
  default: ({ onComplete }: { onComplete: (s: number, ok: boolean, summary?: unknown) => void }) => (
    <div data-testid="mock-dice-game">
      Dice Game
      <button onClick={() => onComplete(diceComplete.score, diceComplete.isSuccess, diceComplete.summary)}>
        finish-dice-turn
      </button>
    </div>
  ),
}));

describe('Game Component Integration', () => {
  let mockNextTurn;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNextTurn = vi.fn();
    // Start from a pristine store: the setState below is partial, and the
    // store outlives each test. Without this a test that set
    // enforcedDiceMode: 'digital' hid the score input from every physical-mode
    // test declared after it — 12 order-dependent failures under
    // --sequence.shuffle. reset() keeps enforcedDiceMode on purpose (it is a
    // room setting that survives leaving a room), so it is cleared explicitly.
    useGameStore.getState().reset();
    _resetTimersForTests();
    // The physical-chain and dice-panel caches live in localStorage and are
    // restored on mount: a chain cached by one test turned the next test's
    // Kniffel Yes/No into a mid-chain score box.
    localStorage.clear();
    sessionStorage.clear();
    useGameStore.setState({
      enforcedDiceMode: null,
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
      // Reset for the same reason diceMode is: the store outlives each test,
      // so a test that switches to classic would otherwise change what the
      // yes/no and score-input controls DO for every test declared after it
      // (classic routes them through the chain, not straight to nextTurn).
      ruleset: 'modernized',
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

  it('automatically advances turn after the flip plus 5 seconds on Stop card in online game', () => {
    useGameStore.setState({ currentCard: 'Stop' });
    render(<Game />);

    expect(mockNextTurn).not.toHaveBeenCalled();

    // The buzzer waits for the card flip to finish, and the auto-continue
    // waits STOP_CARD_AUTO_CONTINUE_MS beyond that (see Game.tsx).
    act(() => {
      vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS - 1);
    });
    expect(mockNextTurn, 'not yet — one tick short of the real deadline').not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
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

  it('plays buzzer sound when Stop card is drawn locally or online, once the flip finishes', async () => {
    act(() => {
      useGameStore.setState({ currentCard: 'Stop' });
    });
    render(<Game />);

    expect(await import('../utils/soundEffects').then(m => m.playBuzzer), 'not yet — the flip is still playing').not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });
    expect(await import('../utils/soundEffects').then(m => m.playBuzzer)).toHaveBeenCalled();

    vi.clearAllMocks();

    act(() => {
      useGameStore.setState({ currentCard: 'Stop', isOnline: false });
    });
    render(<Game />);
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });

    expect(await import('../utils/soundEffects').then(m => m.playBuzzer)).toHaveBeenCalled();
  });

  it('triggers animation and sound on consecutive Feuerwerk draws, once the flip finishes', async () => {
    const playSuccess = await import('../utils/soundEffects').then(m => m.playSuccess);
    const confetti = await import('canvas-confetti').then(m => m.default);

    act(() => {
      useGameStore.setState({ currentCard: 'Feuerwerk', cards: ['Feuerwerk', 'Stop'] });
    });

    const { rerender } = render(<Game />);

    expect(playSuccess, 'not yet — the flip is still playing').not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });

    // First draw
    expect(playSuccess).toHaveBeenCalledTimes(1);
    expect(confetti).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Consecutive draw of Feuerwerk: currentCard stays 'Feuerwerk', cards array length decreases
    act(() => {
      useGameStore.setState({ currentCard: 'Feuerwerk', cards: ['Stop'] });
    });

    rerender(<Game />);
    act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });

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

  // Kicking mid-game is not reversible, so the pill now opens the same kind
  // of confirm dialog End Game/Leave/Undo use (see ConfirmModal.tsx) instead
  // of kicking on the tap itself.
  it('renders a Kick button next to disconnected player when current user is the host, and kicks only after confirming', () => {
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
    expect(kickPlayerMock).not.toHaveBeenCalled();
    expect(screen.getByText('lobby.kickConfirm')).toBeInTheDocument();

    fireEvent.click(screen.getByText('common.confirm'));
    expect(kickPlayerMock).toHaveBeenCalledWith('socket-client');
    expect(screen.queryByText('lobby.kickConfirm')).toBeNull();
  });

  it('cancelling the mid-game kick confirm dialog does not kick the player', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'game.kick' }));
    fireEvent.click(screen.getByText('common.cancel'));

    expect(kickPlayerMock).not.toHaveBeenCalled();
    expect(screen.queryByText('lobby.kickConfirm')).toBeNull();
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
      // This used to define its own handleDiceComplete inside the test and
      // assert that it had called its own mock -- Game.tsx's real handler
      // never ran, and deleting it would not have failed anything. The mock
      // panel now calls the onComplete it was actually given.
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'Plus_Minus',
      });
      diceComplete.score = 0;
      diceComplete.isSuccess = true;
      diceComplete.summary = undefined;

      render(<Game />);
      fireEvent.click(screen.getByRole('button', { name: /game.controls.rollDice/i }));
      fireEvent.click(screen.getByText('finish-dice-turn'));

      expect(mockNextTurn).toHaveBeenCalledWith(0, true, undefined);
      expect(screen.queryByTestId('mock-dice-game'), 'the panel stayed open over the next turn').toBeNull();
    });

    it('passes a bust through to nextTurn as a failure', () => {
      // The other edge of the same handler, and the one that decides whether
      // the turn banks anything at all.
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'Plus_Minus',
      });
      // The summary rides along verbatim: it is what records the chain, and
      // handleDiceComplete's whole job is to forward all three unchanged.
      const summary = { cards: [], ended: 'null', forfeitedScore: 750 };
      diceComplete.score = 750;
      diceComplete.isSuccess = false;
      diceComplete.summary = summary;

      render(<Game />);
      fireEvent.click(screen.getByRole('button', { name: /game.controls.rollDice/i }));
      fireEvent.click(screen.getByText('finish-dice-turn'));

      expect(mockNextTurn).toHaveBeenCalledWith(750, false, summary);
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

  describe('classic physical chains', () => {
    beforeEach(() => {
      useGameStore.setState({ ruleset: 'classic', diceMode: 'physical' });
    });
    // No afterEach reset: the outer beforeEach already restores 'modernized'
    // for every test, and resetting here runs before RTL unmounts Game, so the
    // store update would land outside act().

    it('a Kniffel Yes does not commit: it pre-fills 2000 and offers bank or draw', () => {
      useGameStore.setState({ currentCard: 'Kniffel' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));

      expect(mockNextTurn).not.toHaveBeenCalled();
      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement;
      expect(scoreInput.value).toBe('2000');
      expect(screen.getByTestId('physical-draw-next-card')).toBeInTheDocument();

      fireEvent.click(screen.getByText('game.controls.nextTurn'));
      expect(mockNextTurn).toHaveBeenCalledWith(2000, true, expect.objectContaining({
        cards: [{ card: 'Kniffel', completed: true }],
        ended: 'banked',
      }));
    });

    // Bug: clearing the pre-filled box after a Yes and pressing Next Turn
    // (the bank-or-draw choice's own "bank" action, with nothing to bank)
    // committed ended:'null' — an honest bust — while STILL marking the
    // just-answered card completed:true, because handleNextTurn passed
    // physicalAwaitingChoice straight through as lastCardCompleted regardless
    // of whether anything was actually banked. That double-counted the turn:
    // busts++ AND timesKniffelCompleted++ AND totalTuttos++ for a turn that
    // scored 0 and banked nothing — a completed Kniffel that also ended null.
    it('clearing the pre-filled box after a Yes and committing is an honest bust, not a completed tutto', () => {
      useGameStore.setState({ currentCard: 'Kniffel' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));
      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement;
      expect(scoreInput.value).toBe('2000');

      fireEvent.change(scoreInput, { target: { value: '' } });
      fireEvent.click(screen.getByText('game.controls.nextTurn'));

      expect(mockNextTurn).toHaveBeenCalledWith(0, false, expect.objectContaining({
        cards: [{ card: 'Kniffel', completed: false }],
        ended: 'null',
        tuttoCount: 0,
      }));
      // Nothing was typed at commit time, so there is nothing to record as
      // forfeited either — the summary must not claim a completed card AND a
      // forfeit AND a tutto all from the same zero-value turn.
      const summary = mockNextTurn.mock.calls[0][2];
      expect(summary.forfeitedScore).toBeUndefined();
    });

    it('a bust forfeits the chain and records what it cost', () => {
      // Physical mode had no way to SAY "I rolled a null". The only exit from
      // a scoring card was Next Turn, which reads banked-or-not from whether
      // the typed total is above zero — so a bust meant clearing the box by
      // hand, and forgetting to banked a chain the player had just lost.
      // Zeroing it also destroyed the number, which is why physical could
      // never record highestForfeitedTurnScore the way digital does.
      useGameStore.setState({ currentCard: '300' });
      render(<Game />);

      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
      fireEvent.change(scoreInput, { target: { value: '1500' } });
      fireEvent.click(screen.getByText('game.controls.bust'));

      expect(mockNextTurn).toHaveBeenCalledWith(0, false, expect.objectContaining({
        ended: 'null',
        forfeitedScore: 1500,
      }));
    });

    it('offers no bust button on Feuerwerk, whose null banks instead', () => {
      // The official classic rule: a Feuerwerk null BANKS the accumulated
      // total and ends the turn. Next Turn with the total typed in is that
      // move; a forfeit button beside it would offer the opposite.
      useGameStore.setState({ currentCard: 'Feuerwerk' });
      render(<Game />);

      expect(screen.queryByText('game.controls.bust')).not.toBeInTheDocument();
    });

    it('offers no bust button while a special card awaits its yes or no', () => {
      // Nothing to bust on yet: the card is answered with Yes/No, and a No
      // already forfeits the chain with the typed total (handleYesNo).
      useGameStore.setState({ currentCard: 'Kniffel' });
      render(<Game />);

      expect(screen.queryByText('game.controls.bust')).not.toBeInTheDocument();
    });

    it('relays the chain to the room, so a timeout is not read as a modernized turn', () => {
      // Game wires DiceGame's onStateChange for DIGITAL only, so a physical
      // turn streamed nothing and the server saw liveTurnState: null.
      // advanceTurnOnTimeout decides "was this classic?" by whether the live
      // snapshot carries a chain — so an AFK classic physical turn was
      // committed through the modernized path: a bust it never rolled, every
      // earlier card's counter thrown away, the classic records lost, and no
      // summary for undo to put the cards back with.
      const mockPush = vi.fn();
      useGameStore.setState({ currentCard: 'Kniffel', pushLiveTurnState: mockPush });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));

      expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
        cardsThisTurn: ['Kniffel'],
        // The bank-or-draw choice is open, which is the state an AFK physical
        // player parks in — and the one no dice count can express.
        lastCardCompleted: true,
        keptDice: [],
        currentRoll: [],
      }));
    });

    it('relays nothing while watching someone else take their turn', () => {
      // The server accepts a liveTurnState only from the host or the seat
      // whose turn it is, so a spectator's relay would be a silent no-op at
      // best — and this client's chain is not the one being played.
      const mockPush = vi.fn();
      useGameStore.setState({
        currentCard: 'Kniffel',
        pushLiveTurnState: mockPush,
        myName: 'Bob',
        currentPlayer: { name: 'Alice', socketId: 'socket1', score: 0, position: 1 },
      });
      render(<Game />);

      expect(mockPush).not.toHaveBeenCalled();
    });

    it('a Plus/Minus Yes pre-fills 1000 and the banked summary carries the success', () => {
      useGameStore.setState({ currentCard: 'Plus_Minus' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));
      expect(mockNextTurn).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('game.controls.nextTurn'));
      expect(mockNextTurn).toHaveBeenCalledWith(1000, true, expect.objectContaining({
        // Nothing typed before the Yes, so the card resolved on a total of 0.
        plusMinusScores: [0],
        cards: [{ card: 'Plus_Minus', completed: true }],
        ended: 'banked',
      }));
    });

    it('a special-card No forfeits the whole chain with a null summary', () => {
      useGameStore.setState({ currentCard: 'Kniffel' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.no/i }));
      expect(mockNextTurn).toHaveBeenCalledWith(0, false, expect.objectContaining({
        cards: [{ card: 'Kniffel', completed: false }],
        ended: 'null',
      }));
    });

    it('drawing the next card records the chain, and the final bank carries every card', () => {
      const mockDraw = vi.fn(() => {
        useGameStore.setState({ currentCard: '400' });
        return '400' as const;
      });
      useGameStore.setState({ currentCard: '300', drawCardMidTurn: mockDraw });
      render(<Game />);

      const scoreInput = screen.getByPlaceholderText('game.controls.scorePlaceholder');
      fireEvent.change(scoreInput, { target: { value: '350' } });
      fireEvent.click(screen.getByTestId('physical-draw-next-card'));
      expect(mockDraw).toHaveBeenCalled();
      expect(mockNextTurn).not.toHaveBeenCalled();
      // The running total stays in the input across the draw.
      expect((screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement).value).toBe('350');

      // The card-flip animation GameControls plays on the '300'->'400' change
      // above has to finish (its exit/enter swap otherwise leaves the score
      // input mid-transition, where a change event no longer reaches live state)
      // before the running total can be edited again.
      act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });
      fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '1150' } });
      fireEvent.click(screen.getByText('game.controls.nextTurn'));
      expect(mockNextTurn).toHaveBeenCalledWith(1150, true, expect.objectContaining({
        cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
        tuttoCount: 1,
        ended: 'banked',
      }));
    });

    // Feuerwerk ends the turn on its null, banking whatever was accumulated —
    // there is no tutto to carry into another card, so drawing on is not a
    // move the rules have. Digital mode has always refused it (see
    // canDrawAfterTutto in DiceGame); physical offered the button anyway.
    it('offers no draw on Feuerwerk — its null banks and ends the turn', () => {
      const mockDraw = vi.fn();
      useGameStore.setState({ currentCard: 'Feuerwerk', drawCardMidTurn: mockDraw });
      render(<Game />);

      // The rest of the card's controls are untouched: the total is still
      // entered and banked here, only the draw is gone.
      expect(screen.getByPlaceholderText('game.controls.scorePlaceholder')).toBeInTheDocument();
      expect(screen.getByText('game.controls.nextTurn')).toBeInTheDocument();
      expect(screen.queryByTestId('physical-draw-next-card')).not.toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '750' } });
      fireEvent.click(screen.getByText('game.controls.nextTurn'));
      expect(mockDraw).not.toHaveBeenCalled();
      expect(mockNextTurn).toHaveBeenCalledWith(750, true, expect.objectContaining({
        cards: [{ card: 'Feuerwerk', completed: true }],
        ended: 'banked',
      }));
    });

    // Feuerwerk completes by banking (see TurnCardPlayed), which is what
    // digital records for the same turn — physical said `completed: false`
    // because the flag it passes is the special cards' bank-or-draw choice,
    // and Feuerwerk never opens one.
    it('marks a banked Feuerwerk completed, without counting a tutto for it', () => {
      useGameStore.setState({ currentCard: 'Feuerwerk' });
      render(<Game />);

      fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '750' } });
      fireEvent.click(screen.getByText('game.controls.nextTurn'));

      expect(mockNextTurn).toHaveBeenCalledWith(750, true, expect.objectContaining({
        cards: [{ card: 'Feuerwerk', completed: true }],
        tuttoCount: 0,
        ended: 'banked',
      }));
    });

    it('leaves a Feuerwerk that banked nothing uncompleted — it reached no goal', () => {
      useGameStore.setState({ currentCard: 'Feuerwerk' });
      render(<Game />);

      fireEvent.click(screen.getByText('game.controls.nextTurn'));

      expect(mockNextTurn).toHaveBeenCalledWith(0, false, expect.objectContaining({
        cards: [{ card: 'Feuerwerk', completed: false }],
        tuttoCount: 0,
        ended: 'null',
      }));
    });

    it('keeps a Feuerwerk drawn onto a chain out of the tutto count', () => {
      const mockDraw = vi.fn(() => {
        useGameStore.setState({ currentCard: 'Feuerwerk' });
        return 'Feuerwerk' as const;
      });
      useGameStore.setState({ currentCard: '300', drawCardMidTurn: mockDraw });
      render(<Game />);

      fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '1300' } });
      fireEvent.click(screen.getByTestId('physical-draw-next-card'));
      // Let the card-flip GameControls plays on the card change finish before
      // editing the score input again (see the matching comment above).
      act(() => { vi.advanceTimersByTime(CARD_FLIP_MS); });
      fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '1600' } });
      fireEvent.click(screen.getByText('game.controls.nextTurn'));

      // Only the 300's tutto is known to have happened: the Feuerwerk was
      // completed by banking, not by clearing six dice.
      expect(mockNextTurn).toHaveBeenCalledWith(1600, true, expect.objectContaining({
        cards: [{ card: '300', completed: true }, { card: 'Feuerwerk', completed: true }],
        tuttoCount: 1,
        ended: 'banked',
      }));
    });

    it('a Stop card drawn mid-chain auto-forfeits the whole chain (online)', () => {
      const mockDraw = vi.fn(() => {
        useGameStore.setState({ currentCard: 'Stop' });
        return 'Stop' as const;
      });
      useGameStore.setState({ currentCard: '300', drawCardMidTurn: mockDraw });
      render(<Game />);

      fireEvent.click(screen.getByTestId('physical-draw-next-card'));
      // The online Stop auto-continue commits the chain forfeit, once the
      // buzzer's own card-flip wait plus the auto-continue delay both elapse.
      act(() => { vi.advanceTimersByTime(CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS); });

      expect(mockNextTurn).toHaveBeenCalledWith(0, false, expect.objectContaining({
        cards: [{ card: '300', completed: true }, { card: 'Stop', completed: false }],
        ended: 'stopCard',
      }));
      expect(mockNextTurn).toHaveBeenCalledTimes(1);
    });

    it('hides the Apply-bonus helper for classic (the total is entered fully computed)', () => {
      useGameStore.setState({ currentCard: 'x2' });
      render(<Game />);
      expect(screen.queryByText('game.controls.applyBonus')).not.toBeInTheDocument();
    });

    it('a classic Kleeblatt keeps the committing Yes/No (instant win or forfeit)', () => {
      useGameStore.setState({ currentCard: 'Kleeblatt' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));
      expect(mockNextTurn).toHaveBeenCalledWith(0, true, expect.objectContaining({
        cards: [{ card: 'Kleeblatt', completed: true }],
        tuttoCount: 2,
        ended: 'banked',
      }));
    });

    describe('chain persistence across a reload', () => {
      beforeEach(() => {
        localStorage.clear();
      });

      afterEach(() => {
        localStorage.clear();
      });

      it('restores the chain and the typed running total from the turn cache', () => {
        useGameStore.setState({ currentCard: '400', round: 3, currentPlayerIndex: 0 });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:3:0:400:classic',
          cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
          plusMinusScores: [],
          awaitingChoice: false,
          scoreInput: '350',
        }));
        render(<Game />);

        const input = screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement;
        expect(input.value).toBe('350');

        fireEvent.click(screen.getByText('game.controls.nextTurn'));
        expect(mockNextTurn).toHaveBeenCalledWith(350, true, expect.objectContaining({
          cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
          ended: 'banked',
        }));
      });

      it('restores straight into the bank-or-draw choice when the Yes was already answered', () => {
        useGameStore.setState({ currentCard: 'Kniffel', round: 2, currentPlayerIndex: 0 });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:2:0:Kniffel:classic',
          cards: [{ card: 'Kniffel', completed: true }],
          plusMinusScores: [],
          awaitingChoice: true,
          scoreInput: '2000',
        }));
        render(<Game />);

        // The choice controls, not the yes/no buttons.
        expect(screen.getByTestId('physical-draw-next-card')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /game.controls.yes/i })).not.toBeInTheDocument();
        expect((screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement).value).toBe('2000');
      });

      it('refuses to draw past the chain-card cap, and the bank still carries the capped chain', () => {
        // Every validator that carries a chain (this cache, the pushed
        // snapshot, the turn summary) refuses anything past MAX_CHAIN_CARDS
        // wholesale — and the refusal must land BEFORE drawCardMidTurn, or
        // the drawn card would vanish from both the chain and the deck.
        const mockDraw = vi.fn(() => '400' as const);
        useGameStore.setState({ currentCard: '300', round: 1, drawCardMidTurn: mockDraw });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:1:0:300:classic',
          cards: [
            ...Array.from({ length: MAX_CHAIN_CARDS - 1 }, () => ({ card: '300', completed: true })),
            { card: '300', completed: false },
          ],
          plusMinusScores: [],
          awaitingChoice: false,
          scoreInput: '500',
        }));
        render(<Game />);

        fireEvent.click(screen.getByTestId('physical-draw-next-card'));
        expect(mockDraw).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('game.controls.nextTurn'));
        expect(mockNextTurn).toHaveBeenCalledWith(500, true, expect.objectContaining({ ended: 'banked' }));
        expect(mockNextTurn.mock.calls[0][2].cards).toHaveLength(MAX_CHAIN_CARDS);
      });

      it('allows the draw right up to the cap, then refuses', () => {
        const mockDraw = vi.fn(() => {
          useGameStore.setState({ currentCard: '400' });
          return '400' as const;
        });
        useGameStore.setState({ currentCard: '300', round: 1, drawCardMidTurn: mockDraw });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:1:0:300:classic',
          cards: [
            ...Array.from({ length: MAX_CHAIN_CARDS - 2 }, () => ({ card: '300', completed: true })),
            { card: '300', completed: false },
          ],
          plusMinusScores: [],
          awaitingChoice: false,
          scoreInput: '',
        }));
        render(<Game />);

        fireEvent.click(screen.getByTestId('physical-draw-next-card'));
        expect(mockDraw).toHaveBeenCalledTimes(1); // MAX_CHAIN_CARDS - 1 → the cap
        fireEvent.click(screen.getByTestId('physical-draw-next-card'));
        expect(mockDraw).toHaveBeenCalledTimes(1); // at the cap → refused
      });

      it('discards a cache stamped for a different turn instead of resuming it', () => {
        useGameStore.setState({ currentCard: '400', round: 4, currentPlayerIndex: 0 });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:3:0:400:classic', // an earlier round's turn
          cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
          plusMinusScores: [],
          awaitingChoice: false,
          scoreInput: '350',
        }));
        render(<Game />);

        expect((screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement).value).toBe('');
        expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();

        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '500' } });
        fireEvent.click(screen.getByText('game.controls.nextTurn'));
        expect(mockNextTurn).toHaveBeenCalledWith(500, true, expect.objectContaining({
          cards: [{ card: '400', completed: false }],
        }));
      });

      it('persists the typed total on the first card, before any chain action', () => {
        useGameStore.setState({ currentCard: '300', round: 1, currentPlayerIndex: 0 });
        render(<Game />);

        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '350' } });
        const cached = JSON.parse(localStorage.getItem('tutto_physical_turn_state') ?? 'null');
        expect(cached).toMatchObject({
          turnKey: 'local:1:0:300:classic',
          cards: [{ card: '300', completed: false }],
          scoreInput: '350',
        });

        // Clearing the input leaves nothing worth keeping.
        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '' } });
        expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();
      });

      it('a garbled score input does not take the restored chain down with it', () => {
        useGameStore.setState({ currentCard: '400', round: 2, currentPlayerIndex: 0 });
        localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
          turnKey: 'local:2:0:400:classic',
          cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
          plusMinusScores: [],
          awaitingChoice: false,
          scoreInput: 'not-a-number!',
        }));
        render(<Game />);

        // The input falls back to empty; the chain — which feeds undo and
        // every per-card counter — still restores.
        expect((screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement).value).toBe('');
        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '500' } });
        fireEvent.click(screen.getByText('game.controls.nextTurn'));
        expect(mockNextTurn).toHaveBeenCalledWith(500, true, expect.objectContaining({
          cards: [{ card: '300', completed: true }, { card: '400', completed: false }],
        }));
      });

      it('an externally advanced turn resets the input and leaves no phantom cache entry', () => {
        // Undo, the online Stop auto-continue and a server timeout advance
        // the turn slot without passing through the commit handlers that
        // reset the input. Digits surviving into the new slot would be
        // re-cached by the write-through under the NEW turn's key — undoing
        // the lifecycle clear one render later.
        useGameStore.setState({ currentCard: '300', round: 1, currentPlayerIndex: 0 });
        render(<Game />);

        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '500' } });
        expect(JSON.parse(localStorage.getItem('tutto_physical_turn_state') ?? 'null')).not.toBeNull();

        // The slot changes underneath the component (e.g. undo rewinding).
        act(() => { useGameStore.setState({ round: 2 }); });

        expect((screen.getByPlaceholderText('game.controls.scorePlaceholder') as HTMLInputElement).value).toBe('');
        expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();
      });

      it('writes the cache as the chain grows and clears it on commit', () => {
        const mockDraw = vi.fn(() => {
          useGameStore.setState({ currentCard: '400' });
          return '400' as const;
        });
        useGameStore.setState({ currentCard: 'Kniffel', round: 1, currentPlayerIndex: 0, drawCardMidTurn: mockDraw });
        render(<Game />);

        fireEvent.click(screen.getByRole('button', { name: /game.controls.yes/i }));
        let cached = JSON.parse(localStorage.getItem('tutto_physical_turn_state') ?? 'null');
        expect(cached).toMatchObject({
          turnKey: 'local:1:0:Kniffel:classic',
          cards: [{ card: 'Kniffel', completed: true }],
          awaitingChoice: true,
        });

        fireEvent.click(screen.getByTestId('physical-draw-next-card'));
        cached = JSON.parse(localStorage.getItem('tutto_physical_turn_state') ?? 'null');
        expect(cached).toMatchObject({
          // Stamped with the POST-draw card, the same key a reload will build.
          turnKey: 'local:1:0:400:classic',
          cards: [{ card: 'Kniffel', completed: true }, { card: '400', completed: false }],
          awaitingChoice: false,
        });

        fireEvent.change(screen.getByPlaceholderText('game.controls.scorePlaceholder'), { target: { value: '2400' } });
        fireEvent.click(screen.getByText('game.controls.nextTurn'));
        expect(mockNextTurn).toHaveBeenCalled();
        expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();
      });
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
      const cachedState = { turnScore: 150, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2:modernized' };
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

      const cachedState = { turnScore: 75, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2:modernized' };
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
        localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50, turnKey: 'local:1:0:x2:modernized' }));
        vi.advanceTimersByTime(400); // past DiceGame's 300ms debounce
      });

      // The toast should NOT have been called — no cache was present at mount
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
      // And the dice game modal should not have been auto-opened
      // (it was never opened because there was no cached state at mount)
    });

    it('clears liveTurnState in the store when the dice turn ends in local mode', () => {
      const cachedState = { turnScore: 100, keptDice: [], currentRoll: [], turnKey: 'local:1:0:x2:modernized' };
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

    it('refuses a chain snapshot that predates a mid-chain draw', () => {
      // The relayed snapshot carries no turn key (the server strips it), so
      // re-stamping it with the current one asserts it belongs to the current
      // card. The ~300ms snapshot debounce means a draw can land while the
      // last pushed snapshot still describes the card BEFORE it — resuming
      // that one hands its six kept dice and its accumulated total to a card
      // the player never played, letting them bank a chain they did not earn.
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        currentCard: 'Kniffel',
        ruleset: 'classic',
        liveTurnState: {
          turnScore: 2000,
          keptDice: [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v })),
          currentRoll: [],
          kniffelProgress: [],
          tuttosThisTurn: 1,
          cardsThisTurn: ['300'], // the chain still ends on the PREVIOUS card
          plusMinusScores: [],
          chainTuttoCount: 1,
        },
        justReconnected: true,
      });

      render(<Game />);
      act(() => { vi.advanceTimersByTime(100); });

      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(mockAddToast).not.toHaveBeenCalledWith('game.resumingDiceGame');
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('still resumes a chain snapshot that does describe the current card', () => {
      const mockAddToast = vi.fn();
      useGameStore.setState({
        addToast: mockAddToast,
        currentCard: 'Kniffel',
        ruleset: 'classic',
        liveTurnState: {
          turnScore: 2000,
          keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
          cardsThisTurn: ['300', 'Kniffel'],
          plusMinusScores: [], chainTuttoCount: 1,
        },
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

  describe('undo while the dice panel is open', () => {
    // The panel covers the screen but the controls behind it stay mounted and
    // focusable (no focus trap, no inert) — so Undo was reachable by Tab from
    // behind it. Undoing hands the turn back to the PREVIOUS player while the
    // current one's dice panel is still up, and their roll then commits onto
    // whoever undo just made current.
    beforeEach(() => {
      // The panel must only ever be open because THIS test opened it — the
      // reconnect-resume path above reopens it from a cached snapshot.
      localStorage.clear();
      useGameStore.setState({
        diceMode: 'digital',
        currentCard: 'x2',
        round: 2,
        previousCard: '300',
        previousScore: 500,
        previousPlayerName: 'Alice',
        previousWasBust: false,
        finished: false,
        justReconnected: false,
        liveTurnState: null,
      });
    });

    afterEach(() => {
      localStorage.clear();
    });

    const undoButton = () => screen.getByText('game.controls.undo').closest('button') as HTMLButtonElement;

    it('offers undo while the panel is closed', () => {
      render(<Game />);
      expect(undoButton()).toBeEnabled();
    });

    it('withdraws undo for as long as the panel is open, and offers it again after', () => {
      render(<Game />);

      fireEvent.click(screen.getByText('game.controls.rollDice'));
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(undoButton()).toBeDisabled();

      // The mocked DiceGame never completes, so the panel is closed the way an
      // externally advanced turn closes it: the turn moves to someone else.
      // Host, so this client may still undo once it is no longer its turn
      // (an earlier test used to leave isHost: true behind for this one).
      act(() => {
        useGameStore.setState({ isOnline: true, isHost: true, myName: 'Bob', currentPlayerIndex: 0 });
      });
      expect(screen.queryByTestId('mock-dice-game')).not.toBeInTheDocument();
      expect(undoButton()).toBeEnabled();
    });
  });

  describe('undo eligibility', () => {
    const undoButton = () => screen.getByText('game.controls.undo').closest('button') as HTMLButtonElement;

    // Bug: hasUndoableTurn used to check only previousCard/previousPlayerName
    // being non-null, not whether that player was still in the roster. A left
    // (or kicked, or reconnect-timed-out) previous player left Undo enabled
    // for a click calculateUndo would then silently refuse — canUndoState
    // (shared with calculateUndo's own guard) closes that gap.
    it('disables undo when the previous player left the roster', () => {
      useGameStore.setState({
        currentCard: 'x2',
        currentPlayerIndex: 0,
        players: [{ name: 'Alice', socketId: 'socket1', score: 0, position: 1 }],
        previousCard: '300',
        previousScore: 500,
        previousPlayerName: 'Bob', // no longer in players
        finished: false,
      });
      render(<Game />);
      expect(undoButton()).toBeDisabled();
    });
  });

  describe('the Stop card controls while the dice panel is open', () => {
    // Same exposure as Undo above: the panel covers the screen but the
    // controls behind it stay mounted and reachable. A classic chain that
    // draws a Stop inside DiceGame flips the store card to 'Stop' while the
    // panel stays up showing the forfeit summary, which DiceGame commits
    // itself — a live Continue behind it commits the turn a second time,
    // without that summary. Whether that button renders is pinned in
    // GameControls.test.tsx: jsdom never finishes a framer-motion exit
    // animation, so the controls block the flip to Stop swaps in never
    // mounts here at all, and this level can only assert the commit.
    beforeEach(() => {
      // The panel must only ever be open because THIS test opened it.
      localStorage.clear();
      useGameStore.setState({
        // Online, because the Stop auto-continue only arms itself under
        // isOnline && isMyTurn (Game.tsx) — offline there is no timer to catch
        // and the "commits nothing" assertion below could never fail.
        isOnline: true,
        ruleset: 'classic',
        diceMode: 'digital',
        currentCard: '300',
        justReconnected: false,
        liveTurnState: null,
      });
    });

    afterEach(() => {
      // Store state is not reset here: the outer beforeEach already restores
      // ruleset/isOnline for every test, and resetting here runs before RTL
      // unmounts Game, so the update would land outside act().
      localStorage.clear();
    });

    it('offers a committing Continue on a Stop card while the panel is closed', () => {
      useGameStore.setState({ currentCard: 'Stop' });
      render(<Game />);

      fireEvent.click(screen.getByRole('button', { name: /game.controls.continue/i }));
      expect(mockNextTurn).toHaveBeenCalledTimes(1);
    });

    it('commits nothing from behind the panel when a chain draws a Stop', () => {
      render(<Game />);

      fireEvent.click(screen.getByText('game.controls.rollDice'));
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      // DiceGame drew the Stop mid-chain: the card flips underneath, the
      // panel stays up and keeps the summary it is about to commit.
      act(() => { useGameStore.setState({ currentCard: 'Stop' }); });
      // Past the auto-continue Game.tsx would arm for a Stop it owns — the
      // open panel is the only thing keeping that timer from being scheduled.
      act(() => { vi.advanceTimersByTime(STOP_CARD_AUTO_CONTINUE_MS); });

      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockNextTurn).not.toHaveBeenCalled();
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

      // The shared ModalShell backdrop: it carries no onDismiss for this
      // panel, so the click is a no-op rather than a way out of a turn.
      fireEvent.click(screen.getByTestId('modal-backdrop'));
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
      expect(mockNextTurn).not.toHaveBeenCalled();
    });

    it('keeps the dice backdrop underneath the gameplay HUD layers', () => {
      // The pre-ModalShell backdrop sat at z-50, below the toasts (z-150),
      // the emoji reactions (z-100) and the corner buttons (z-100) — the
      // "Resuming your dice game..." toast fires exactly when this panel
      // opens, and reactions land mid-roll. ModalShell's default z-200
      // backdrop buried all of them, so this panel carries the variant that
      // restores the old layer. jsdom computes no stacking, hence the pin
      // on the class itself.
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);
      fireEvent.click(screen.getByText('game.controls.rollDice'));

      expect(screen.getByTestId('modal-backdrop')).toHaveClass('modal-backdrop-under-hud');
    });

    it('the open dice panel is announced as a modal dialog', () => {
      // It was the one full-screen overlay in the app that was not a
      // ModalShell: no dialog role, no aria-modal, so nothing told assistive
      // tech a dialog had opened and Tab walked straight into the page behind.
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);

      expect(document.querySelector('[aria-modal="true"]')).toBeNull();

      fireEvent.click(screen.getByText('game.controls.rollDice'));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toContainElement(screen.getByTestId('mock-dice-game'));
    });

    it('names the dice panel after the card being played', () => {
      // aria-modal with no name announces a bare "dialog". A direct label
      // rather than a referenced heading, because the panel's own <h2> is
      // swapped out for the summary and the drawn-card reveal — there is no id
      // that is always there to point at.
      useGameStore.setState({ diceMode: 'digital', currentCard: 'Plus_Minus' });
      render(<Game />);
      fireEvent.click(screen.getByText('game.controls.rollDice'));

      expect(screen.getByRole('dialog')).toHaveAccessibleName('dice.title - Plus/Minus');
    });

    it('escape does not dismiss the dice panel', () => {
      // Once opened it auto-rolls immediately; there is no backing out of a
      // turn already in progress (the backdrop click above is refused for the
      // same reason).
      useGameStore.setState({ diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);
      fireEvent.click(screen.getByText('game.controls.rollDice'));

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();
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

    it('Space does not commit a Stop card while the dice modal is open (classic mid-chain Stop)', () => {
      // A classic chain drew a Stop inside DiceGame: the store card flips to
      // 'Stop' while the modal stays up showing the forfeit summary, which
      // DiceGame itself commits (with the chain summary). The dice overlay
      // sets no aria-modal — DiceGame's own shortcuts must keep working — so
      // Game's Space/Enter binding stays live and used to commit the turn a
      // second time, without the summary.
      useGameStore.setState({ ruleset: 'classic', diceMode: 'digital', currentCard: 'x2' });
      render(<Game />);

      fireEvent.keyDown(window, { key: ' ' }); // opens the dice modal
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      act(() => { useGameStore.setState({ currentCard: 'Stop' }); });
      expect(screen.getByTestId('mock-dice-game')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: ' ' });
      expect(mockNextTurn).not.toHaveBeenCalled();
      // No ruleset reset here: beforeEach already restores 'modernized', and
      // setting it while Game is still mounted updates state outside act().
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

      // The id rides the header, never the URL — see deviceStatsRequest.
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/stats/device?mode=normalized',
        { headers: { 'x-tutto-device': 'device-1' } },
      );
      expect(setPreGameStats).toHaveBeenCalledWith({
        highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
        highestFeuerwerkTurnScore: null, highestX2TurnScore: null,
        mostCardsInTurn: null, highestForfeitedTurnScore: null,
      });
    });

    it('carries the two classic records into the snapshot', async () => {
      // The device bucket keeps 9 records (RECORD_COLUMNS); PreGameStats
      // declared 5, and the four it dropped included BOTH of the classic-only
      // ones -- mostCardsInTurn and highestForfeitedTurnScore, the records
      // only a chained turn can set. They are fetched, merged and displayed
      // everywhere else; the end screen alone had nothing to compare against,
      // so a classic player's best chain was never announced.
      const setPreGameStats = vi.fn();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ mostCardsInTurn: 4, highestForfeitedTurnScore: 1900 }),
      })) as unknown as typeof fetch;

      useGameStore.setState({ isOnline: true, deviceId: 'device-1', setPreGameStats });
      render(<Game />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(setPreGameStats).toHaveBeenCalledWith(expect.objectContaining({
        mostCardsInTurn: 4, highestForfeitedTurnScore: 1900,
      }));
    });

    it('skips the snapshot for a custom game, and clears any left over from an earlier one', async () => {
      // The snapshot exists only to detect a new personal record, and a custom
      // game never claims one — so there is nothing to fetch. Clearing still
      // has to happen: a snapshot kept from an earlier game in the same
      // session would be diffed against this game's numbers.
      const setPreGameStats = vi.fn();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ highestTurnScore: 1500 }),
      })) as unknown as typeof fetch;

      useGameStore.setState({
        isOnline: true, deviceId: 'device-1', setPreGameStats,
        winningScore: 1000,
      });
      render(<Game />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(setPreGameStats).toHaveBeenCalledWith(null);
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
        mostCardsInTurn: null, highestForfeitedTurnScore: null,
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
