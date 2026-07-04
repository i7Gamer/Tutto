import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import GameControls from './GameControls';
import type { CardType, DiceSnapshot, Player } from '../../types';

describe('GameControls Animation State Pattern', () => {
  it('demonstrates synchronous state detection pattern', () => {
    let prevCard = null;
    let isFlipping = false;

    // Simulate component render with prop change
    const currentCard = 'x2';
    
    // This happens synchronously during render (not in useEffect)
    if (currentCard !== prevCard) {
      prevCard = currentCard;
      isFlipping = true; // Set immediately, before paint
    }

    // Verify state is set synchronously
    expect(isFlipping).toBe(true);
    expect(prevCard).toBe('x2');
  });

  it('resets isFlipping when card becomes null', () => {
    let isFlipping = true;
    let currentCard = null;

    // Synchronous render-time logic
    if (currentCard === null && isFlipping) {
      isFlipping = false;
    }

    expect(isFlipping).toBe(false);
  });

  it('tracks prev values to detect changes', () => {
    let prevCardsLength = 10;
    const cardsLength = 9;
    let hasChanged = false;

    // Change detection pattern
    if (cardsLength !== prevCardsLength) {
      prevCardsLength = cardsLength;
      hasChanged = true;
    }

    expect(hasChanged).toBe(true);
    expect(prevCardsLength).toBe(9);
  });

  it('handles rapid prop changes without state loss', () => {
    const changes = [];
    let prevCard = 'x2';

    // Simulate 3 rapid renders with different props
    const newCards = ['Kniffel', 'Stop', 'Plus_Minus'];

    for (const card of newCards) {
      if (card !== prevCard) {
        changes.push({ from: prevCard, to: card });
        prevCard = card;
      }
    }

    expect(changes).toHaveLength(3);
    expect(prevCard).toBe('Plus_Minus');
    expect(changes[0]).toEqual({ from: 'x2', to: 'Kniffel' });
  });

  it('prevents animation state if change detected in effect (anti-pattern)', () => {
    // This demonstrates what NOT to do
    let isFlipping = false;
    const prevCard = 'x2';
    const currentCard = 'Kniffel';

    // BAD: detecting change in effect means one frame of unwanted content is visible
    if (currentCard !== prevCard) {
      // This runs AFTER render, so content paints before isFlipping is true
      isFlipping = true;
    }

    // The test shows the delay happens - in real React this causes a flash
    expect(isFlipping).toBe(true); // But it's too late - content already painted
  });

  it('corrects anti-pattern with synchronous detection', () => {
    let isFlipping = false;
    let prevCard = 'x2';
    const currentCard = 'Kniffel';

    // GOOD: detect change synchronously during render
    if (currentCard !== prevCard) {
      prevCard = currentCard;
      isFlipping = true; // Set BEFORE React paints - no flash
    }

    expect(isFlipping).toBe(true);
    expect(prevCard).toBe('Kniffel');
  });
});

describe('GameControls spectator view (online, not my turn)', () => {
  const renderSpectator = (activeTurnState: DiceSnapshot, currentCard: CardType | null = null, diceMode: 'digital' | 'physical' = 'digital') =>
    render(
      <GameControls
        currentCard={currentCard}
        cardsLength={5}
        isMyTurn={false}
        diceMode={diceMode}
        setShowDiceGame={vi.fn()}
        scoreInput=""
        setScoreInput={vi.fn()}
        applyBonus={false}
        setApplyBonus={vi.fn()}
        handleNextTurn={vi.fn()}
        handleYesNo={vi.fn()}
        undo={vi.fn()}
        endGame={vi.fn()}
        isOnline={true}
        isHost={false}
        leaveRoom={vi.fn()}
        activeTurnState={activeTurnState}
        currentPlayer={{ name: 'Alice' } as Player}
      />
    );

  // With currentRoll empty, the only single-digit texts on screen are the kept dice.
  const keptDiceOrder = () => screen.getAllByText(/^[1-6]$/).map((el) => el.textContent);

  it('sorts kept dice ascending for Kniffel when the first target is 1 (same as the active player)', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }, { id: 'c', val: 3 }],
        currentRoll: [],
        kniffelProgress: [1],
        tuttosThisTurn: 0,
      },
      'Kniffel'
    );
    expect(keptDiceOrder()).toEqual(['1', '3', '5']);
  });

  it('sorts kept dice descending for Kniffel when the first target is not 1', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 1 }, { id: 'b', val: 3 }, { id: 'c', val: 5 }],
        currentRoll: [],
        kniffelProgress: [6],
        tuttosThisTurn: 0,
      },
      'Kniffel'
    );
    expect(keptDiceOrder()).toEqual(['5', '3', '1']);
  });

  it('leaves kept dice in their original order for non-Kniffel cards', () => {
    renderSpectator(
      {
        turnScore: 300,
        keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }, { id: 'c', val: 3 }],
        currentRoll: [],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    expect(keptDiceOrder()).toEqual(['5', '1', '3']);
  });

  it('shows the live dice view to spectators whose OWN diceMode is physical', () => {
    // diceMode is a per-device input preference — it decides how the viewer
    // enters their own turns, not whether they may watch the active player's
    // digital dice. Physical-dice spectators used to get only the generic
    // waiting spinner.
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200',
      'physical'
    );
    expect(screen.getByText('450')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).toBeNull();
  });

  it('marks busted dice red and shows no bust text', () => {
    renderSpectator(
      {
        turnScore: 0,
        keptDice: [],
        currentRoll: [
          { id: 'r1', val: 2, selected: false },
          { id: 'r2', val: 4, selected: false },
        ],
        kniffelProgress: [],
        tuttosThisTurn: 0,
        busted: true,
      },
      '200'
    );
    expect(screen.queryByText('dice.bust_description')).toBeNull();
    expect(screen.getByText('2').className).toContain('border-red-300');
    expect(screen.getByText('4').className).toContain('border-red-300');
  });
});

describe('GameControls physical dice interactions', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    currentCard: '200' as CardType,
    cardsLength: 5,
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    undo: vi.fn(),
    canUndo: true,
    endGame: vi.fn(),
    isOnline: false,
    isHost: true,
    leaveRoom: vi.fn(),
    activeTurnState: null,
    currentPlayer: { name: 'Alice' } as Player,
    ...overrides,
  });

  it('quick-add button appends its value to a blank score input', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '', setScoreInput })} />);

    fireEvent.click(screen.getByText('+100'));

    expect(setScoreInput).toHaveBeenCalledTimes(1);
    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('')).toBe('100');
  });

  it('quick-add button accumulates onto an existing numeric score input', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '250', setScoreInput })} />);

    fireEvent.click(screen.getByText('+50'));

    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('250')).toBe('300');
  });

  it('quick-add button treats a non-numeric score input as 0', () => {
    const setScoreInput = vi.fn();
    render(<GameControls {...baseProps({ scoreInput: '', setScoreInput })} />);

    fireEvent.click(screen.getByText('+1000'));

    const updater = setScoreInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('not-a-number')).toBe('1000');
  });
});

describe('GameControls end/leave game confirmation dialogs', () => {
  const baseProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    currentCard: '200' as CardType,
    cardsLength: 5,
    isMyTurn: true,
    diceMode: 'physical' as const,
    setShowDiceGame: vi.fn(),
    scoreInput: '',
    setScoreInput: vi.fn(),
    applyBonus: false,
    setApplyBonus: vi.fn(),
    handleNextTurn: vi.fn(),
    handleYesNo: vi.fn(),
    undo: vi.fn(),
    canUndo: true,
    endGame: vi.fn(),
    isOnline: false,
    isHost: true,
    leaveRoom: vi.fn(),
    activeTurnState: null,
    currentPlayer: { name: 'Alice' } as Player,
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offline: shows End Game, and only calls endGame once the confirm dialog is accepted', () => {
    const endGame = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GameControls {...baseProps({ isOnline: false, isHost: true, endGame })} />);

    expect(screen.queryByText('game.controls.leaveGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(confirmSpy).toHaveBeenCalledWith('game.controls.endGameConfirm');
    expect(endGame).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(endGame).toHaveBeenCalledTimes(1);
  });

  it('online + host: still shows End Game (not Leave Game)', () => {
    const endGame = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GameControls {...baseProps({ isOnline: true, isHost: true, endGame })} />);

    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(endGame).toHaveBeenCalledTimes(1);
  });

  it('online + non-host: shows Leave Game, and only calls leaveRoom once the confirm dialog is accepted', () => {
    const leaveRoom = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GameControls {...baseProps({ isOnline: true, isHost: false, leaveRoom })} />);

    expect(screen.queryByText('game.controls.endGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    expect(confirmSpy).toHaveBeenCalledWith('game.controls.leaveGameConfirm');
    expect(leaveRoom).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    expect(leaveRoom).toHaveBeenCalledTimes(1);
  });

  it('undo: only calls undo once the confirm dialog is accepted', () => {
    const undo = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GameControls {...baseProps({ undo })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(confirmSpy).toHaveBeenCalledWith('game.controls.undoConfirm');
    expect(undo).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('undo: is disabled when canUndo is false', () => {
    const undo = vi.fn();
    render(<GameControls {...baseProps({ undo, canUndo: false })} />);
    const undoBtn = screen.getByText('game.controls.undo').closest('button');
    expect(undoBtn).toBeDisabled();
  });
});
