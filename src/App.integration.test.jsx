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
    const localButton = screen.getByText(/Local Play/i);
    fireEvent.click(localButton);

    // 2. Change Winning Score to 1000
    const advancedOptionsButton = screen.getByText(/Show Advanced Options/i);
    fireEvent.click(advancedOptionsButton);
    
    // The input has label "Winning Score"
    // However, getByLabelText might fail if the label isn't linked with 'for', so let's get the input by value
    const winningScoreInput = screen.getByDisplayValue('6000');
    await userEvent.clear(winningScoreInput);
    await userEvent.type(winningScoreInput, '1000');

    // 3. Add Players
    const playerInput = screen.getByPlaceholderText(/Name of new player/i);
    await userEvent.type(playerInput, 'Alice');
    fireEvent.click(screen.getByRole('button', { name: /Add/i }));

    await userEvent.clear(playerInput);
    await userEvent.type(playerInput, 'Bob');
    fireEvent.click(screen.getByRole('button', { name: /Add/i }));

    // 4. Start Game
    const startButton = screen.getByText(/Start Game!/i);
    fireEvent.click(startButton);

    // 5. Game Board Renders
    await waitFor(() => {
      expect(screen.getByText('Round')).toBeTruthy();
      expect(screen.getAllByText(/Alice/i).length).toBeGreaterThan(0);
    });

    // 6. First Card is drawn automatically.
    // It should be '200' due to our deterministic random mock.

    // Alice's turn. First card is '200'.
    // We just do 1 Tutto!
    const openModalButton = await screen.findByRole('button', { name: /Roll Dice/i });
    fireEvent.click(openModalButton);
    
    // Wait for modal to render
    await screen.findByRole('heading', { name: /Dice Game/i });

    // Click the Roll 6 Dice button inside the modal
    const actualRollButton = await screen.findByRole('button', { name: /Roll 6 Dice/i });
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
    const stopButton = await screen.findByText(/Stop & Score/i);
    fireEvent.click(stopButton);

    // Summary modal
    await waitFor(() => {
      expect(screen.getByText(/Tutto!/i)).toBeTruthy();
      expect(screen.getByText(/2200/)).toBeTruthy();
    });

    const continueButton = screen.getByText(/Continue to Next Player/i);
    fireEvent.click(continueButton);

    // Bob's turn
    await waitFor(() => {
      expect(screen.getAllByText(/Bob/i).length).toBeGreaterThan(0);
    });

    // Bob's card is automatically drawn due to nextTurn logic.
    // It should be '200'.

    // Bob rolls dice
    const rollBobModal = await screen.findByRole('button', { name: /Roll Dice/i });
    fireEvent.click(rollBobModal);

    await screen.findByRole('heading', { name: /Dice Game/i });

    const actualRollBob = await screen.findByRole('button', { name: /Roll 6 Dice/i });
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

    const stopBob = await screen.findByText(/Stop & Score/i);
    fireEvent.click(stopBob);

    // Bob's summary
    await waitFor(() => {
      expect(screen.getAllByText(/100/).length).toBeGreaterThan(0);
    });

    const continueBob = screen.getByText(/Continue to Next Player/i);
    fireEvent.click(continueBob);

    // Round is over! Alice has 2200, Bob has 100. Winning score is 1000.
    // End Screen should be shown!
    await waitFor(() => {
      expect(screen.getByText(/Winner: Alice/i)).toBeTruthy();
      expect(screen.getAllByText(/2200/).length).toBeGreaterThan(0);
    });

    Math.random = originalRandom;
  });

  it('plays a full online game procedure', async () => {
    let mockRolls = [];
    vi.spyOn(diceLogic, 'rollDie').mockImplementation(() => {
      if (mockRolls.length > 0) return mockRolls.shift();
      return 1;
    });

    render(<App />);

    // Select Online Game
    const onlineButton = screen.getByText(/Online Play/i);
    fireEvent.click(onlineButton);

    // Enter Room and Name
    const roomInput = screen.getByPlaceholderText(/e.g. 1234/i);
    const nameInput = screen.getByPlaceholderText(/e.g. Alice/i);
    
    await userEvent.type(roomInput, 'TESTROOM');
    await userEvent.type(nameInput, 'HostAlice');

    // Click Join / Create
    const joinButton = screen.getByText(/Join \/ Create/i);
    fireEvent.click(joinButton);

    // Wait for the joinRoom emit
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
        roomId: 'TESTROOM',
        name: 'HostAlice'
      }), expect.any(Function));
    });

    // Simulate server response (success, isHost=true)
    const joinCallback = mockEmit.mock.calls.find(c => c[0] === 'joinRoom')[2];
    await act(async () => {
      joinCallback({ success: true, isHost: true, gameState: null, hostId: 'socket1' });
      // flush microtasks
      await Promise.resolve();
    });

    // Wait for Lobby to render
    await waitFor(() => {
      expect(screen.getByText(/Room: TESTROOM/i)).toBeTruthy();
    });

    // Now let another player join via gameState emit from server
    const stateCallback = mockOn.mock.calls.find(c => c[0] === 'gameState')[1];
    act(() => {
      stateCallback({
        players: [{ name: 'HostAlice', score: 0 }, { name: 'PlayerBob', score: 0 }],
        currentPlayerIndex: null,
        currentCard: null,
        cards: [],
        round: 1,
        finished: false,
        gameTimeInSeconds: 0,
        initialCards: { "200": 5 },
        randomOrder: false,
        winningScore: 5000,
        chartValues: [], chartNames: [], chartLabels: []
      });
    });

    // Wait for PlayerBob to appear in the list
    await waitFor(() => {
      expect(screen.getByText('PlayerBob')).toBeTruthy();
    });

    // Click Show Advanced Options
    const advancedBtn = screen.getByText(/Show Advanced Options/i);
    fireEvent.click(advancedBtn);

    // Toggle a global config option, like randomOrder
    const randomOrderCheckbox = screen.getByLabelText(/Random Order/i);
    fireEvent.click(randomOrderCheckbox);
    
    // We expect an emit 'updateConfig' with randomOrder
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('updateConfig', expect.objectContaining({
        randomOrder: expect.any(Boolean)
      }));
    });

    // Host starts game
    const startButton = screen.getByText(/Start Game!/i);
    fireEvent.click(startButton);

    // The game state should be updated to start the game
    // We expect an emit 'pushState'
    await waitFor(() => {
      expect(mockEmit).toHaveBeenCalledWith('pushState', expect.objectContaining({
        roomId: 'TESTROOM',
        newState: expect.objectContaining({
          currentPlayerIndex: 0
        })
      }));
    });
  });
});
