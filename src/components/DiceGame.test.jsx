import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DiceGame from './DiceGame';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn()
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn()
}));

describe('DiceGame Integration', () => {
  let diceSequence = [];
  const originalRandom = Math.random;

  beforeEach(() => {
    diceSequence = [];
    // Mock Math.random to return specific dice values (1-6)
    Math.random = () => {
      if (diceSequence.length > 0) {
        const val = diceSequence.shift();
        return (val - 1.0) / 6.0;
      }
      return 0; // Default rolls a 1
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    Math.random = originalRandom;
  });

  it('Feuerwerk: correctly aggregates points across multiple Tuttos', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: 1, 1, 1, 2, 2, 2 -> 1000 + 0 = 1000 points if we select 1,1,1
    // Actually, let's select all 6 because 2,2,2 is a triplet (200 points).
    // Total for this roll = 1200.
    diceSequence = [1, 1, 1, 2, 2, 2];
    
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    let dice = screen.getAllByText(/1|2/);
    dice.forEach(d => fireEvent.click(d)); // Select all 6 dice

    // The score display should show 1200
    expect(screen.getByText('1200')).toBeInTheDocument();

    // Roll Again (Since it's a Tutto on Feuerwerk, it rolls 6 new dice)
    // Roll 2: 5, 5, 5, 3, 3, 3 -> 500 + 300 = 800 points.
    diceSequence = [5, 5, 5, 3, 3, 3];
    fireEvent.click(screen.getByText(/Roll Again/i));

    // Turn score is now 1200. Current roll valid score is 800.
    // Total should be 2000.
    dice = screen.getAllByText(/5|3/);
    dice.forEach(d => fireEvent.click(d));

    expect(screen.getByText('2000')).toBeInTheDocument();

    // Roll Again (Another Tutto!)
    // Roll 3: Bust!
    diceSequence = [2, 3, 4, 6, 2, 3];
    fireEvent.click(screen.getByText(/Roll Again/i));

    // We busted. Feuerwerk should NOT wipe our 2000 points.



    // Verify summary shows success for Feuerwerk with aggregated points
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('2000')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Continue to Next Player/i));

    expect(onComplete).toHaveBeenCalledWith(2000, true);
  });

  it('Feuerwerk: busting on the first roll sends isSuccess=false (failure)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: Bust! (No 1s, 5s, or triplets)
    diceSequence = [2, 3, 4, 6, 2, 3];
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    expect(screen.getByText(/Bust!/i)).toBeInTheDocument();



    expect(screen.getByText('Bust!')).toBeInTheDocument();
    
    fireEvent.click(screen.getByText(/Continue to Next Player/i));

    // Turn score is 0, so it's a failure (isSuccess=false)
    expect(onComplete).toHaveBeenCalledWith(0, false);
  });

  it('Feuerwerk: busting after accumulating points sends isSuccess=true', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: 5 (50 points)
    diceSequence = [5, 2, 3, 4, 6, 6];
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    fireEvent.click(screen.getByText('5'));

    // Score is 50
    expect(screen.getByText('50')).toBeInTheDocument();

    // Roll Again (5 dice remaining)
    // Roll 2: Bust!
    diceSequence = [2, 3, 4, 6, 2];
    fireEvent.click(screen.getByText(/Roll Again/i));





    // Verify summary shows success because we accumulated 50 points
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Continue to Next Player/i));

    // Turn score is 50, so it's a success (isSuccess=true)? No, it's a bust now!
    expect(onComplete).toHaveBeenCalledWith(50, true);
  });

  it('200-600 Cards: only applies bonus when all dice are selected (Tutto)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="200" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: Three 1s, and some junk.
    diceSequence = [1, 1, 1, 2, 3, 4];
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    const ones = screen.getAllByText('1');
    ones.forEach(d => fireEvent.click(d));

    // Base score is 1000. Bonus (+200) should NOT be applied yet!
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.queryByText('1200')).not.toBeInTheDocument();

    // Roll Again for the remaining 3 dice
    diceSequence = [5, 5, 5];
    fireEvent.click(screen.getByText(/Roll Again/i));

    // Select the three 5s (500 points).
    const fives = screen.getAllByText('5');
    fives.forEach(d => fireEvent.click(d));

    // Now all 6 dice are kept (3 from before + 3 now). This is a Tutto!
    // The base score was 1000. Current valid is 500. Total = 1500.
    // Plus the 200 card bonus = 1700.
    // Wait, the bonus is applied in handleAction when making the Tutto (i.e. clicking "Roll Again" or automatic finish).
    // Actually, on non-Feuerwerk cards, achieving a Tutto triggers an AUTO finish!
    // Let's click "Roll Again"? No, if isTutto is true, it automatically completes and shows summary!
    // Let's trigger the action by clicking "Stop & Score" or it auto completes.
    // Wait! In DiceGame.jsx, when isTutto is reached, does it auto-complete immediately?
    // The user MUST click "Roll Again" or "Finish Card" or "Stop & Score".
    // Wait, let's see DiceGame.jsx. "Stop & Score" is the button.
    
    // If I just click the dice, they are selected. They move to kept when an action is taken.
    // So right now, selectedVals = [5,5,5]. keptDice = [1,1,1].
    // Total selected + kept = 6.
    // To trigger the Tutto bonus, the user must click "Stop & Score" (which becomes "Finish Card" for special cards, but "Stop & Score" for 200).
    
    fireEvent.click(screen.getByText(/Stop/i));

    // The game finishes, bonus should be applied!
    // Base 1000 (kept) + 500 (current) = 1500. Bonus = 200. Total = 1700.
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('Tutto!')).toBeInTheDocument();
    expect(screen.getByText('1700')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Continue to Next Player/i));
    expect(onComplete).toHaveBeenCalledWith(1700, true);
  });

  it('x2 Card: only applies multiplier when all dice are selected (Tutto)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="x2" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [5, 2, 3, 4, 6, 6];
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    // Select the 5 (50 points)
    fireEvent.click(screen.getByText('5'));

    // Score is 50. NOT 100 (because multiplier not applied yet)
    expect(screen.getByText('50')).toBeInTheDocument();
    
    // Stop early without Tutto
    fireEvent.click(screen.getByText(/Stop/i));

    // Should finish with 50 points, no multiplier.
    expect(screen.getByText('50')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Continue/i));
    expect(onComplete).toHaveBeenCalledWith(50, true);
  });

  it('x2 Card: applies multiplier when Tutto is achieved', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="x2" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [1, 1, 1, 5, 5, 5]; // 1000 + 500 = 1500 points
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    // Select all 6 dice
    screen.getAllByText(/1|5/).forEach(d => fireEvent.click(d));

    // Score is 1500 currently selected, not kept yet.
    // Click Stop to apply Tutto
    fireEvent.click(screen.getByText(/Stop/i));

    // Multiplier applied: 1500 * 2 = 3000
    expect(screen.getByText('3000')).toBeInTheDocument();
    expect(screen.getByText('Tutto!')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Continue/i));
    expect(onComplete).toHaveBeenCalledWith(3000, true);
  });

  it('Kleeblatt: requires two Tuttos to win, first Tutto forces a reroll', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} onCancel={vi.fn()} />);

    // First Roll: Tutto!
    diceSequence = [1, 1, 1, 5, 5, 5];
    fireEvent.click(screen.getByText(/Roll 6 Dice/i));

    // Select all 6 dice
    screen.getAllByText(/1|5/).forEach(d => fireEvent.click(d));

    // UI should indicate 0/2 Tuttos
    expect(screen.getByText(/Tuttos: 0 \/ 2/i)).toBeInTheDocument();

    // Click "Roll 2nd Tutto"
    diceSequence = [2, 2, 2, 3, 3, 3]; // Second roll dice
    fireEvent.click(screen.getByText(/Roll 2nd Tutto/i));

    // We shouldn't have won yet
    expect(screen.queryByText('Success!')).not.toBeInTheDocument();

    // Now select all 6 dice for the second roll
    screen.getAllByText(/2|3/).forEach(d => fireEvent.click(d));

    // UI should indicate 1/2 Tuttos
    expect(screen.getByText(/Tuttos: 1 \/ 2/i)).toBeInTheDocument();

    // Click "Finish Card" to lock in the second Tutto
    fireEvent.click(screen.getByText(/Finish Card/i));

    // Now we should win!
    expect(screen.getByText('Success!')).toBeInTheDocument();
    expect(screen.getByText('Tutto!')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Continue/i));
    expect(onComplete).toHaveBeenCalledWith(expect.any(Number), true);
  });
});
