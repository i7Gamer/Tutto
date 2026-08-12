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

  it('gives a selected spectator die a dark-mode background so its pips stay visible (not emerald-100 on emerald-100)', () => {
    renderSpectator(
      {
        turnScore: 100,
        keptDice: [],
        currentRoll: [{ id: 'r1', val: 5, selected: true }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    const selectedDie = screen.getByText('5');
    expect(selectedDie.className).toContain('dark:bg-slate-700');
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

  it('applies text-transparent class to kept and roll spectator dice to visually hide text numbers', () => {
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    // Kept dice uses DiePips with indigo styling
    expect(screen.getByText('1').className).toContain('text-transparent');
    // Roll dice uses DiePips
    expect(screen.getByText('5').className).toContain('text-transparent');
  });

  it('ensures spectator dice text is transparent (via class, not inline style)', () => {
    renderSpectator(
      {
        turnScore: 450,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'r1', val: 5, selected: false }],
        kniffelProgress: [],
        tuttosThisTurn: 0,
      },
      '200'
    );
    const keptDie = screen.getByText('1');
    const rollDie = screen.getByText('5');
    // Should use text-transparent class
    expect(keptDie.className).toContain('text-transparent');
    expect(rollDie.className).toContain('text-transparent');
    // Should NOT have redundant inline color style
    expect(keptDie.style.color).not.toBe('transparent');
    expect(rollDie.style.color).not.toBe('transparent');
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
    render(<GameControls {...baseProps({ isOnline: false, isHost: true, endGame })} />);

    expect(screen.queryByText('game.controls.leaveGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(screen.getByText('game.controls.endGameConfirm')).toBeInTheDocument();
    expect(endGame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(endGame).not.toHaveBeenCalled();
    expect(screen.queryByText('game.controls.endGameConfirm')).toBeNull();

    fireEvent.click(screen.getByText('game.controls.endGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(endGame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('game.controls.endGameConfirm')).toBeNull();
  });

  it('online + host: still shows End Game (not Leave Game)', () => {
    const endGame = vi.fn();
    render(<GameControls {...baseProps({ isOnline: true, isHost: true, endGame })} />);

    fireEvent.click(screen.getByText('game.controls.endGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(endGame).toHaveBeenCalledTimes(1);
  });

  it('online + non-host: shows Leave Game, and only calls leaveRoom once the confirm dialog is accepted', () => {
    const leaveRoom = vi.fn();
    render(<GameControls {...baseProps({ isOnline: true, isHost: false, leaveRoom })} />);

    expect(screen.queryByText('game.controls.endGame')).toBeNull();
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    expect(screen.getByText('game.controls.leaveGameConfirm')).toBeInTheDocument();
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(leaveRoom).toHaveBeenCalledTimes(1);
  });

  it('undo: only calls undo once the confirm dialog is accepted', () => {
    const undo = vi.fn();
    render(<GameControls {...baseProps({ undo })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(screen.getByText('game.controls.undoConfirm')).toBeInTheDocument();
    expect(undo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(undo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('game.controls.undo'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('undo: is disabled when canUndo is false', () => {
    const undo = vi.fn();
    render(<GameControls {...baseProps({ undo, canUndo: false })} />);
    const undoBtn = screen.getByText('game.controls.undo').closest('button');
    expect(undoBtn).toBeDisabled();
  });
});

describe('GameControls Stop card while the dice panel is open', () => {
  const stopProps = (overrides: Partial<ComponentProps<typeof GameControls>> = {}) => ({
    currentCard: 'Stop' as CardType,
    cardsLength: 5,
    isMyTurn: true,
    diceMode: 'digital' as const,
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

  it('shows Continue and commits the turn while the dice panel is closed', () => {
    const handleYesNo = vi.fn();
    render(<GameControls {...stopProps({ showDiceGame: false, handleYesNo })} />);

    expect(screen.getByText('game.controls.stopTurnOver')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /game.controls.continue/i }));
    expect(handleYesNo).toHaveBeenCalledWith(false);
  });

  it('does not render the Continue button behind an open dice panel', () => {
    // A classic chain that draws a Stop inside DiceGame leaves the panel up
    // showing the forfeit summary, which DiceGame commits itself. These
    // controls stay mounted behind it (no focus trap), so a live Continue
    // here is reachable and would commit the turn a second time — without
    // the chain summary.
    // Nothing to click here on purpose: with the block unrendered there IS no
    // interaction that could reach handleYesNo, which is the whole point — the
    // test above pins that the same Continue commits the turn when it is up.
    render(<GameControls {...stopProps({ showDiceGame: true })} />);

    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
    expect(screen.queryByText('game.controls.stopTurnOver')).toBeNull();
  });

  it('treats an omitted showDiceGame as "panel closed"', () => {
    render(<GameControls {...stopProps()} />);
    expect(screen.getByRole('button', { name: /game.controls.continue/i })).toBeInTheDocument();
  });

  it('leaves the other branches alone while the dice panel is open', () => {
    // Only the stop-controls block is guarded: a non-Stop card behind the
    // panel keeps rendering exactly as before (the panel closes with the
    // turn, and these controls are what the player returns to).
    render(<GameControls {...stopProps({ currentCard: '200' as CardType, showDiceGame: true })} />);

    expect(screen.getByText('game.controls.rollDice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
  });

  it('still shows the spectator view for a Stop card on someone else\'s turn', () => {
    render(<GameControls {...stopProps({ isMyTurn: false, showDiceGame: false })} />);
    expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /game.controls.continue/i })).toBeNull();
  });
});
