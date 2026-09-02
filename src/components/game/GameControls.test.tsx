import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import GameControls from './GameControls';
import type { CardType, DiceSnapshot, Player } from '../../types';
import { CARD_FLIP_MS } from '../../utils/uiTimings';

describe('GameControls card-flip state', () => {
  // Replaces six tests that imported GameControls, never rendered it, and
  // asserted on local variables they had just assigned -- deleting
  // GameControls.tsx would not have failed one of them. What they were
  // gesturing at is real and is below: the flip is derived DURING render, not
  // in an effect, so the new card and the hidden controls land on the same
  // frame instead of the old content painting once first.
  //
  // Real timers throughout: the controls sit inside an AnimatePresence, so
  // their disappearance is one exit animation away and fake timers do not
  // drive it. Every wait below is bounded by the flip's own deadline rather
  // than by a guess, so none of them can pass merely by being slow.
  const flipProps = (overrides = {}) => ({
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

  const scoreInputShown = () => screen.queryByPlaceholderText('game.controls.scorePlaceholder') !== null;
  // Comfortably past the only clock in play, so "still hidden" cannot mean
  // "the timer had not got round to it yet".
  const PAST_THE_FLIP_MS = CARD_FLIP_MS * 2;
  const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('hides the turn controls for exactly one flip when the card changes', async () => {
    const { rerender } = render(<GameControls {...flipProps({ currentCard: '200' })} />);
    expect(scoreInputShown(), 'the first render has nothing to flip from').toBe(true);

    rerender(<GameControls {...flipProps({ currentCard: 'x2' })} />);
    await waitFor(() => {
      expect(scoreInputShown(), 'the old card\'s controls stayed up over the new card').toBe(false);
    });

    await waitFor(() => {
      expect(scoreInputShown(), 'the controls never came back').toBe(true);
    }, { timeout: PAST_THE_FLIP_MS });
  });

  it('flips on a deck-size change too, not only on a new card', async () => {
    // The other half of the trigger condition. A classic mid-turn draw moves
    // both at once, but the deck can also shrink on its own (a reshuffle),
    // and the controls have to be covered for that too -- the card face
    // behind them is about to be replaced either way.
    //
    // Asserted as the transition, never as "still visible after a wait":
    // written that way this test passed while the flip WAS happening, because
    // the settle it used outlasted the flip it was denying.
    const { rerender } = render(<GameControls {...flipProps({ currentCard: 'x2', cardsLength: 5 })} />);
    expect(scoreInputShown()).toBe(true);

    rerender(<GameControls {...flipProps({ currentCard: 'x2', cardsLength: 4 })} />);

    await waitFor(() => {
      expect(scoreInputShown(), 'a deck-size change alone left the old controls up').toBe(false);
    });
    await waitFor(() => expect(scoreInputShown()).toBe(true), { timeout: PAST_THE_FLIP_MS });
  });

  it('clears a flip left standing when there is no card on either side of the change', async () => {
    // Going card -> null starts a flip whose timer never arms (the effect
    // needs a currentCard), so the reset branch is the only thing that can
    // end it. Without that branch the controls stay hidden for good.
    const { rerender } = render(<GameControls {...flipProps({ currentCard: '200' })} />);

    rerender(<GameControls {...flipProps({ currentCard: null })} />);
    await waitFor(() => expect(scoreInputShown()).toBe(false));

    await settle(PAST_THE_FLIP_MS);
    expect(scoreInputShown(), 'no card means no timer, so the flip is still standing').toBe(false);

    rerender(<GameControls {...flipProps({ currentCard: null, cardsLength: 4 })} />);

    await waitFor(() => {
      expect(scoreInputShown(), 'the reset branch never ran, so the controls are gone for good').toBe(true);
    });
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

  // The spectator panel mirrors the active player's dice, and the faces are
  // pips — SVG circles carrying no text. The dice INSIDE the roll panel were
  // given names in 62c1f1b; this mirror was missed, so a spectator using a
  // screen reader heard the running total but never the dice behind it.
  it('names every mirrored die for a screen reader', () => {
    renderSpectator({
      turnScore: 300,
      keptDice: [{ id: 'a', val: 5 }, { id: 'b', val: 1 }],
      currentRoll: [{ id: 'c', val: 3, selected: false }, { id: 'd', val: 6, selected: true }],
      kniffelProgress: [],
      tuttosThisTurn: 0,
    }, '200');

    // Two kept plus two rolled — every one of the four, not just the tray.
    const named = screen.getAllByRole('img');
    expect(named).toHaveLength(4);
    named.forEach(die => expect(die).toHaveAttribute('aria-label'));
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

  it('undo: refuses once the turn it was opened for is no longer the last one', () => {
    // pendingAction is plain state and nothing re-read the turn behind it, so
    // the dialog acted on whatever the previous-turn fields held at CONFIRM
    // time. A host opens Undo for Bob's turn; before answering, Carol's turn
    // resolves (or the server timer advances it) and the previous-turn fields
    // are rewritten by the broadcast; Confirm then rewound CAROL's turn — and
    // pushState propagated it to the whole room.
    const undo = vi.fn();
    const { rerender } = render(<GameControls {...baseProps({ undo, undoTurnId: 'Bob:200:4' })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    expect(screen.getByText('game.controls.undoConfirm')).toBeInTheDocument();

    // The turn moves on underneath the open dialog.
    rerender(<GameControls {...baseProps({ undo, undoTurnId: 'Carol:Kniffel:4' })} />);

    expect(
      screen.queryByText('game.controls.undoConfirm'),
      'the dialog must not keep asking about a turn that is gone',
    ).not.toBeInTheDocument();
    expect(undo, 'a different turn must never be undone in its place').not.toHaveBeenCalled();
  });

  it('undo: still undoes the turn it was opened for', () => {
    // The control: the guard above must not simply stop undo working.
    const undo = vi.fn();
    const { rerender } = render(<GameControls {...baseProps({ undo, undoTurnId: 'Bob:200:4' })} />);

    fireEvent.click(screen.getByText('game.controls.undo'));
    // An unrelated re-render — a score tick, another player's colour change —
    // leaves the turn identity alone and must not cancel anything.
    rerender(<GameControls {...baseProps({ undo, undoTurnId: 'Bob:200:4' })} />);
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
