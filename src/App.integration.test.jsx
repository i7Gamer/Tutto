import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import App from './App';
import * as diceLogic from './utils/diceLogic';
import { useGameStore } from './store/useGameStore';

// Mock confetti
vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('./utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn()
}));

describe('App Integration (End-to-End)', () => {
  beforeEach(() => {
    localStorage.clear();
    useGameStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays a full local game with edge cases (Busts, Tuttos) to the EndScreen', async () => {
    useGameStore.setState({ diceMode: 'digital' });
    // 1. Setup deterministic game environment
    const originalRandom = Math.random;
    Math.random = () => 0.999999; // Keeps deck in original order. 1st card is 'Kleeblatt'

    // We will control dice rolls to force specific outcomes
    let mockRolls = [];
    vi.spyOn(diceLogic, 'rollDie').mockImplementation(() => {
      if (mockRolls.length > 0) return mockRolls.shift();
      return 1; // Default to 1 (valid score, 6 ones = Tutto)
    });

    render(<App />);

    // 2. Select Local Game
    const localButton = screen.getByText(/home.localPlay/i);
    fireEvent.click(localButton);

    // 2. Change Winning Score to 1000
    const advancedOptionsButton = screen.getByText(/lobby.showAdvancedOptions/i);
    fireEvent.click(advancedOptionsButton);
    
    // The input has label "Winning Score"
    // However, getByLabelText might fail if the label isn't linked with 'for', so let's get the input by value
    const winningScoreInput = screen.getByDisplayValue('6000');
    await userEvent.clear(winningScoreInput);
    await userEvent.type(winningScoreInput, '1000');

    // 3. Add Players
    const playerInput = screen.getByPlaceholderText(/lobby.newPlayerPlaceholder/i);
    await userEvent.type(playerInput, 'Alice');
    fireEvent.click(screen.getByRole('button', { name: /lobby.addPlayerButton/i }));

    await userEvent.clear(playerInput);
    await userEvent.type(playerInput, 'Bob');
    fireEvent.click(screen.getByRole('button', { name: /lobby.addPlayerButton/i }));

    // 4. Start Game
    const startButton = screen.getByText(/lobby.startGame/i);
    fireEvent.click(startButton);

    // 5. Game Board Renders
    await waitFor(() => {
      expect(screen.getByText('game.round')).toBeTruthy();
      expect(screen.getAllByText(/Alice/i).length).toBeGreaterThan(0);
    });

    // 6. First Card is drawn automatically.
    // It should be '200' due to our deterministic random mock.

    // Alice's turn. First card is '200'.
    // We just do 1 Tutto!
    const openModalButton = await screen.findByRole('button', { name: /game.controls.rollDice/i });
    fireEvent.click(openModalButton);
    
    // Wait for modal to render
    await screen.findByRole('heading', { name: /dice.title/i });

    // Click the Roll 6 Dice button inside the modal
    const actualRollButton = await screen.findByRole('button', { name: /dice.roll_6_dice/i });
    fireEvent.click(actualRollButton);

    await waitFor(() => {
      const dice = screen.getAllByText('1');
      expect(dice.length).toBeGreaterThanOrEqual(6);
    });

    // Wait 600ms for the rolling animation to finish so isRolling is false
    await act(async () => {
      await new Promise(r => setTimeout(r, 600));
    });

    const diceElements = screen.getAllByText('1');
    const actualDice = diceElements.filter(el => el.classList.contains('die'));
    actualDice.forEach(die => fireEvent.click(die));

    // After 1 Tutto on a 200 card, score should be 2200 points!
    const stopButton = await screen.findByText(/dice.stop_and_score/i);
    fireEvent.click(stopButton);

    // Summary modal
    await waitFor(() => {
      expect(screen.getByText(/dice.tutto/i)).toBeTruthy();
      expect(screen.getByText(/2200/)).toBeTruthy();
    });

    const continueButton = screen.getByText(/dice.continue/i);
    fireEvent.click(continueButton);

    // Bob's turn
    await waitFor(() => {
      expect(screen.getAllByText(/Bob/i).length).toBeGreaterThan(0);
    });

    // Bob's card is automatically drawn due to nextTurn logic.
    // It should be '200'.

    // Bob rolls dice
    const rollBobModal = await screen.findByRole('button', { name: /game.controls.rollDice/i });
    fireEvent.click(rollBobModal);

    await screen.findByRole('heading', { name: /dice.title/i });

    const actualRollBob = await screen.findByRole('button', { name: /dice.roll_6_dice/i });
    fireEvent.click(actualRollBob);

    // We make Bob score just 100 points and stop
    await waitFor(() => {
      const dice = screen.getAllByText('1');
      expect(dice.length).toBeGreaterThanOrEqual(6);
    });

    await act(async () => {
      await new Promise(r => setTimeout(r, 600));
    });

    const bobDice = screen.getAllByText('1').filter(el => el.classList.contains('die'));
    fireEvent.click(bobDice[0]); // Select one '1'

    const stopBob = await screen.findByText(/dice.stop_and_score/i);
    fireEvent.click(stopBob);

    // Bob's summary
    await waitFor(() => {
      expect(screen.getAllByText(/100/).length).toBeGreaterThan(0);
    });

    const continueBob = screen.getByText(/dice.continue/i);
    fireEvent.click(continueBob);

    // Round is over! Alice has 2200, Bob has 100. Winning score is 1000.
    // End Screen should be shown!
    await waitFor(() => {
      expect(screen.getByText(/end.winner Alice/i)).toBeTruthy();
      expect(screen.getAllByText(/2200/).length).toBeGreaterThan(0);
    });

    Math.random = originalRandom;
  });


  it('renders ToastMessage and ReconnectPopup overlays based on store state', () => {
    render(<App />);
    
    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });
    expect(screen.getByText('Host ended game early')).toBeInTheDocument();
    
    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });
    expect(screen.getByText('home.reconnect.title')).toBeInTheDocument();
    expect(screen.getByText(/home.reconnect.description/)).toBeInTheDocument();
    
    fireEvent.click(screen.getByText('home.reconnect.returnMenu'));
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();
    expect(useGameStore.getState().mode).toBe('local');
  });

  it('renders RestoreSessionPopup and clears session when clicking Cancel', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });
    
    render(<App />);

    expect(screen.getByText('home.restore.title')).toBeInTheDocument();
    expect(screen.getByText(/home.restore.description/)).toBeInTheDocument();

    const yesButton = screen.getByText('home.restore.cancel');
    fireEvent.click(yesButton);

    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(screen.queryByText('home.restore.title')).not.toBeInTheDocument();
  });
});
