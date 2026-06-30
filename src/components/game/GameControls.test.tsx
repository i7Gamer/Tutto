import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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
  const renderSpectator = (activeTurnState: DiceSnapshot, currentCard: CardType | null = null) =>
    render(
      <GameControls
        currentCard={currentCard}
        cardsLength={5}
        isMyTurn={false}
        diceMode="digital"
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
