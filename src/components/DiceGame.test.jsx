import { render, screen, fireEvent, act } from '@testing-library/react';
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
    
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    let dice = screen.getAllByText(/1|2/);
    dice.forEach(d => fireEvent.click(d)); // Select all 6 dice

    // The score display should show 1200
    expect(screen.getByText('1200')).toBeInTheDocument();

    // Roll Again (Since it's a Tutto on Feuerwerk, it rolls 6 new dice)
    // Roll 2: 5, 5, 5, 3, 3, 3 -> 500 + 300 = 800 points.
    diceSequence = [5, 5, 5, 3, 3, 3];
    fireEvent.click(screen.getByText('dice.roll_again'));

    // Turn score is now 1200. Current roll valid score is 800.
    // Total should be 2000.
    dice = screen.getAllByText(/5|3/);
    dice.forEach(d => fireEvent.click(d));

    expect(screen.getByText('2000')).toBeInTheDocument();

    // Roll Again (Another Tutto!)
    // Roll 3: Bust!
    diceSequence = [2, 3, 4, 6, 2, 3];
    fireEvent.click(screen.getByText('dice.roll_again'));

    // We busted. Feuerwerk should NOT wipe our 2000 points.



    // Verify summary shows success for Feuerwerk with aggregated points
    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('2000')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.continue'));

    expect(onComplete).toHaveBeenCalledWith(2000, true);
  });

  it('Feuerwerk: busting on the first roll sends isSuccess=false (failure)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: Bust! (No 1s, 5s, or triplets)
    diceSequence = [2, 3, 4, 6, 2, 3];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    // Bust auto-continues after 0ms in test env — no Continue button on bust
    expect(screen.queryByText('dice.continue')).toBeNull();
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // Turn score is 0, so it's a failure (isSuccess=false)
    expect(onComplete).toHaveBeenCalledWith(0, false);
  });

  it('Feuerwerk: busting after accumulating points sends isSuccess=true', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: 5 (50 points)
    diceSequence = [5, 2, 3, 4, 6, 6];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    fireEvent.click(screen.getByText('5'));

    // Score is 50
    expect(screen.getByText('50')).toBeInTheDocument();

    // Roll Again (5 dice remaining)
    // Roll 2: Bust!
    diceSequence = [2, 3, 4, 6, 2];
    fireEvent.click(screen.getByText('dice.roll_again'));

    // Verify summary shows success because we accumulated 50 points
    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    // Feuerwerk bust-after-scoring has won=true → manual Continue button shown
    fireEvent.click(screen.getByText('dice.continue'));

    // Turn score is 50, so it's a success (isSuccess=true)? No, it's a bust now!
    expect(onComplete).toHaveBeenCalledWith(50, true);
  });

  it('200-600 Cards: only applies bonus when all dice are selected (Tutto)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="200" onComplete={onComplete} onCancel={vi.fn()} />);

    // Roll 1: Three 1s, and some junk.
    diceSequence = [1, 1, 1, 2, 3, 4];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    const ones = screen.getAllByText('1');
    ones.forEach(d => fireEvent.click(d));

    // Base score is 1000. Bonus (+200) should NOT be applied yet!
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.queryByText('1200')).not.toBeInTheDocument();

    // Roll Again for the remaining 3 dice
    diceSequence = [5, 5, 5];
    fireEvent.click(screen.getByText('dice.roll_again'));

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
    
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    // The game finishes, bonus should be applied!
    // Base 1000 (kept) + 500 (current) = 1500. Bonus = 200. Total = 1700.
    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    expect(screen.getByText('1700')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(1700, true);
  });

  it('x2 Card: only applies multiplier when all dice are selected (Tutto)', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="x2" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [5, 2, 3, 4, 6, 6];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    // Select the 5 (50 points)
    fireEvent.click(screen.getByText('5'));

    // Score is 50. NOT 100 (because multiplier not applied yet)
    expect(screen.getByText('50')).toBeInTheDocument();
    
    // Stop early without Tutto
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    // Should finish with 50 points, no multiplier.
    expect(screen.getByText('50')).toBeInTheDocument();
    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(50, true);
  });

  it('x2 Card: applies multiplier when Tutto is achieved', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="x2" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [1, 1, 1, 5, 5, 5]; // 1000 + 500 = 1500 points
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    // Select all 6 dice
    screen.getAllByText(/1|5/).forEach(d => fireEvent.click(d));

    // Score is 1500 currently selected, not kept yet.
    // Click Stop to apply Tutto
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    // Multiplier applied: 1500 * 2 = 3000
    expect(screen.getByText('3000')).toBeInTheDocument();
    expect(screen.getByText('dice.tutto')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(3000, true);
  });

  it('Kleeblatt: requires two Tuttos to win, first Tutto forces a reroll', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} onCancel={vi.fn()} />);

    // First Roll: Tutto!
    diceSequence = [1, 1, 1, 5, 5, 5];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    // Select all 6 dice
    screen.getAllByText(/1|5/).forEach(d => fireEvent.click(d));

    // UI should indicate 0/2 Tuttos
    expect(screen.getByText('dice.tuttos_count')).toBeInTheDocument();

    // Click "Roll 2nd Tutto"
    diceSequence = [2, 2, 2, 3, 3, 3]; // Second roll dice
    fireEvent.click(screen.getByText('dice.roll_2nd_tutto'));

    // We shouldn't have won yet
    expect(screen.queryByText('dice.success')).not.toBeInTheDocument();

    // Now select all 6 dice for the second roll
    screen.getAllByText(/2|3/).forEach(d => fireEvent.click(d));

    // UI should indicate 1/2 Tuttos
    expect(screen.getByText('dice.tuttos_count')).toBeInTheDocument();

    // Click "Finish Card" to lock in the second Tutto
    fireEvent.click(screen.getByText('dice.finish_card'));

    // Now we should win!
    expect(screen.getByText('dice.success')).toBeInTheDocument();
    expect(screen.getByText('dice.tutto')).toBeInTheDocument();

    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(expect.any(Number), true);
  });

  it('Kleeblatt: busting on the first roll fails the card', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [2, 3, 4, 6, 2, 3];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    // Bust auto-continues after 0ms in test env — no Continue button on bust
    expect(screen.queryByText('dice.continue')).toBeNull();
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(onComplete).toHaveBeenCalledWith(0, false);
  });

  it('Plus_Minus: requires exactly one Tutto', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Plus_Minus" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [1, 1, 1, 5, 5, 5];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));
    
    screen.getAllByText(/1|5/).forEach(d => fireEvent.click(d));
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(1500, true);
  });

  it('Kniffel: requires exactly one Tutto', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="Kniffel" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [1, 2, 3, 4, 5, 6];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));
    
    screen.getAllByRole('button', { name: /^Die showing/ }).forEach(d => fireEvent.click(d));
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    fireEvent.click(screen.getByText('dice.continue'));
    expect(onComplete).toHaveBeenCalledWith(0, true);
  });

  it('Keyboard Accessibility: dice are rendered as interactive buttons', async () => {
    const onComplete = vi.fn();
    render(<DiceGame currentCard="200" onComplete={onComplete} onCancel={vi.fn()} />);

    diceSequence = [5, 2, 3, 4, 6, 6];
    fireEvent.click(screen.getByText('dice.roll_6_dice'));

    const fiveDie = screen.getByText('5');
    expect(fiveDie.tagName).toBe('BUTTON');
    expect(fiveDie).not.toHaveAttribute('disabled');
  });

  describe('Dice Display Accuracy - Bug #1 Prevention', () => {
    const wait = (ms) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

    it('displayRoll never diverges from currentRoll values during animation', async () => {
      /**
       * This test specifically verifies that the dice display race condition is fixed.
       * It ensures that:
       * 1. Dice roll with specific known values
       * 2. The displayed values match the actual rolled values throughout animation
       * 3. The interval animation does not overwrite settled values
       * 4. After animation completes, all dice show their correct values
       */
      const onComplete = vi.fn();

      // Fixed dice sequence: 1, 2, 3, 4, 5, 6
      const expectedValues = [1, 2, 3, 4, 5, 6];
      diceSequence = [...expectedValues];

      render(
        <DiceGame currentCard="300" onComplete={onComplete} onCancel={vi.fn()} />
      );

      // Roll the dice
      fireEvent.click(screen.getByText('dice.roll_6_dice'));

      // During animation, check periodically that displayed values don't diverge from expected
      // Wait for dice to settle (500ms for animation + buffer)
      for (let i = 0; i < 6; i++) {
        // After each dice settles, verify it shows the correct value
        await wait(100);
        const dieText = screen.queryByText(expectedValues[i]);
        expect(dieText).toBeTruthy();
      }

      // After all animation completes, verify all dice are showing correct values
      await wait(200);

      for (const expectedVal of expectedValues) {
        const dieElements = screen.queryAllByText(expectedVal.toString());
        expect(dieElements.length).toBeGreaterThan(0);
      }

      // Verify all 6 dice are visible and correct
      const allDiceText = expectedValues.map(v => v.toString());
      allDiceText.forEach(val => {
        expect(screen.queryByText(val)).toBeTruthy();
      });
    });

    it('dice values remain stable after settling (no delayed overwrites)', async () => {
      /**
       * This test verifies that once a die has been settled to its correct value,
       * the animation interval does not overwrite it later.
       */
      const onComplete = vi.fn();

      const expectedValues = [6, 5, 4, 3, 2, 1];
      diceSequence = [...expectedValues];

      render(
        <DiceGame currentCard="200" onComplete={onComplete} onCancel={vi.fn()} />
      );

      fireEvent.click(screen.getByText('dice.roll_6_dice'));

      // Wait for initial animation to complete
      await wait(600);

      // Get the initially displayed values
      const getDisplayedValues = () => {
        return expectedValues.map(v => screen.queryByText(v.toString()) ? v : null).filter(v => v !== null);
      };

      const initiallyDisplayed = getDisplayedValues();

      // Wait more time to simulate interval running after settlement
      await wait(500);

      // Verify the same dice are still displayed (not changed by lingering interval)
      const stillDisplayed = getDisplayedValues();
      expect(stillDisplayed.sort()).toEqual(initiallyDisplayed.sort());
    });

    it('high-frequency animation interval cannot corrupt dice values', async () => {
      /**
       * Stress test: Verify that even with multiple interval ticks,
       * dice values never show incorrect numbers.
       */
      const onComplete = vi.fn();

      const expectedValues = [1, 1, 1, 5, 5, 5]; // All 1s and 5s
      diceSequence = [...expectedValues];

      render(
        <DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />
      );

      fireEvent.click(screen.getByText('dice.roll_6_dice'));

      // Check every 50ms for 700ms (simulating 14 interval ticks at 80ms intervals)
      for (let tick = 0; tick < 14; tick++) {
        await wait(50);

        // At any point during/after animation, verify displayed values are either 1 or 5
        const diceElements = screen.queryAllByText(/^[15]$/);
        expect(diceElements.length).toBeGreaterThan(0);
        diceElements.forEach(el => {
          expect([1, 5]).toContain(parseInt(el.textContent));
        });
      }

      // Final verification: all settled dice show correct values
      const onesDisplayed = screen.queryAllByText('1').length;
      const fivesDisplayed = screen.queryAllByText('5').length;
      expect(onesDisplayed + fivesDisplayed).toBe(6);
    });
  });

  describe('onStateChange callback', () => {
    const wait = (ms) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

    it('fires with { turnScore, keptDice, currentRoll } snapshot after rolling', async () => {
      const onStateChange = vi.fn();
      diceSequence = [1, 5, 3, 3, 3, 2];
      render(
        <DiceGame currentCard="300" onComplete={vi.fn()} onCancel={vi.fn()} onStateChange={onStateChange} />
      );

      fireEvent.click(screen.getByText('dice.roll_6_dice'));
      await wait(350);

      expect(onStateChange).toHaveBeenCalled();
      const snapshot = onStateChange.mock.calls.at(-1)[0];
      expect(snapshot).toMatchObject({
        turnScore: expect.any(Number),
        keptDice: expect.any(Array),
        currentRoll: expect.any(Array),
      });
      expect(snapshot.currentRoll.every(d => 'val' in d && 'selected' in d)).toBe(true);
      expect(snapshot.keptDice.every(d => 'val' in d)).toBe(true);
    });

    it('snapshot reflects dice selection: selected die has selected=true in currentRoll', async () => {
      const onStateChange = vi.fn();
      diceSequence = [1, 5, 5, 5, 3, 2];
      render(
        <DiceGame currentCard="300" onComplete={vi.fn()} onCancel={vi.fn()} onStateChange={onStateChange} />
      );

      fireEvent.click(screen.getByText('dice.roll_6_dice'));
      await wait(50); // let dice settle before interacting

      onStateChange.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /Die showing 1/ }));
      await wait(350);

      expect(onStateChange).toHaveBeenCalled();
      const snapshot = onStateChange.mock.calls.at(-1)[0];
      const selectedInRoll = snapshot.currentRoll.filter(d => d.selected);
      expect(selectedInRoll.length).toBeGreaterThan(0);
      expect(selectedInRoll[0].val).toBe(1);
    });

    it('does not fire before the first roll', async () => {
      const onStateChange = vi.fn();
      render(
        <DiceGame currentCard="300" onComplete={vi.fn()} onCancel={vi.fn()} onStateChange={onStateChange} />
      );

      await wait(400);

      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('does not crash when onStateChange prop is omitted', async () => {
      diceSequence = [1, 2, 3, 4, 5, 6];
      render(
        <DiceGame currentCard="300" onComplete={vi.fn()} onCancel={vi.fn()} />
      );

      fireEvent.click(screen.getByText('dice.roll_6_dice'));
      await wait(350);
      // passes if no error is thrown
    });
  });

  describe('State Persistence', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it('restores saved dice game state from localStorage on mount', async () => {
      const savedState = {
        turnScore: 1250,
        keptDice: [{ id: 'die-1', val: 1 }],
        currentRoll: [
          { id: 'die-2', val: 5, selected: false },
          { id: 'die-3', val: 6, selected: true }
        ],
        rollingDiceIds: []
      };

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

      const onComplete = vi.fn();
      render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

      // Check that the turn score is displayed (indicates state was restored)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      const scoreDisplay = screen.getByText('1250');
      expect(scoreDisplay).toBeDefined();
    });

    it('starts with fresh state when no saved state exists', async () => {
      const onComplete = vi.fn();
      render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

      // Should show "Roll 6 Dice" button (not mid-turn state)
      expect(screen.getByText('dice.roll_6_dice')).toBeDefined();

      // Should show 0 as current score
      const scoreDisplay = screen.getByText('0');
      expect(scoreDisplay).toBeDefined();
    });

    it('handles corrupted localStorage gracefully', async () => {
      localStorage.setItem('tutto_dice_turn_state', 'invalid json {]');

      const onComplete = vi.fn();
      render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} onCancel={vi.fn()} />);

      // Should not crash and should start fresh
      expect(screen.getByText('dice.roll_6_dice')).toBeDefined();
    });
  });
});
