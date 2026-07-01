import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseSavedDiceState } from '../utils/diceTurnState';
import DiceGame from './DiceGame';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

describe('DiceGame State Restoration Logic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('parses and restores turnScore from localStorage', () => {
    const savedState = { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.turnScore).toBe(250);
  });

  it('preserves kniffelProgress array structure when restoring', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [1, 2, 3],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(Array.isArray(restored?.kniffelProgress)).toBe(true);
    expect(restored?.kniffelProgress).toEqual([1, 2, 3]);
  });

  it('correctly converts undefined busted to false', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(false);
  });

  it('preserves busted=true when present', () => {
    const savedState = {
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0,
      busted: true
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(true);
  });

  it('returns null when localStorage has no saved state', () => {
    localStorage.removeItem('tutto_dice_turn_state');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('returns null when saved state is invalid JSON', () => {
    localStorage.setItem('tutto_dice_turn_state', 'not valid json {]');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('provides defaults for missing optional fields', () => {
    const minimalState = { turnScore: 50 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(minimalState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.keptDice).toEqual([]);
    expect(restored?.kniffelProgress).toEqual([]);
    expect(restored?.tuttosThisTurn).toBe(0);
  });
});

describe('DiceGame restored-state bust rendering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows the same "Bust!" summary for a restored Kleeblatt bust as a live one', () => {
    // Simulates a page reload/reconnect mid-Kleeblatt-turn right after busting.
    // Kleeblatt is all-or-nothing (needs 2 successful tuttos), so a bust always
    // forfeits the turn regardless of tuttosThisTurn banked so far — the restored
    // path (DiceGame.tsx init effect) and the live bust path both produce
    // { won: false, score: 0 }, so the rendered summary must match exactly.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 1,
      busted: true,
    }));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    expect(screen.queryByText('dice.success')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.tutto')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.points_gained')).not.toBeInTheDocument();
  });
});
