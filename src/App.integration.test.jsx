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

// Create a mock for socket.io-client that can be configured per test
let mockSocketInstance = null;
vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => mockSocketInstance || {
      on: vi.fn(),
      emit: vi.fn(),
      off: vi.fn(),
      disconnect: vi.fn(),
      id: 'socket-default',
    })
  };
});

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

    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(screen.queryByText('home.restore.title')).not.toBeInTheDocument();
  });

  it('RestoreSessionPopup Cancel button triggers temp socket join+leave flow', async () => {
    const { io } = await import('socket.io-client');
    let connectHandler = null;

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect') {
          connectHandler = handler;
          // Simulate connection after a brief delay
          setTimeout(() => handler(), 5);
        }
      }),
      emit: vi.fn((event, ...args) => {
        // If joinRoom, invoke the callback
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            setTimeout(() => callback({ success: true }), 10);
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'temp-socket-123',
    };

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'TEST_ROOM_123', myName: 'Alice' },
        liveTurnState: { turnScore: 50 },
      });
    });
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50 }));

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');

    fireEvent.click(cancelButton);

    // State should be immediately cleared
    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(useGameStore.getState().liveTurnState).toBeNull();

    // Allow async socket operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify temp socket was created
    expect(io).toHaveBeenCalledWith(expect.any(String));

    // Verify joinRoom was emitted with correct args
    const joinRoomCall = mockSocketInstance.emit.mock.calls.find(c => c[0] === 'joinRoom');
    expect(joinRoomCall).toBeTruthy();
    expect(joinRoomCall[1]).toMatchObject({
      roomId: 'TEST_ROOM_123',
      name: 'Alice',
      deviceId: expect.any(String),
    });

    // Verify leaveRoom was emitted after successful join
    expect(mockSocketInstance.emit).toHaveBeenCalledWith('leaveRoom');

    // Verify socket was disconnected after leaving
    expect(mockSocketInstance.disconnect).toHaveBeenCalled();

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel button cleans up on socket connect_error', async () => {
    const { io } = await import('socket.io-client');
    let connectErrorHandler;

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect_error') {
          connectErrorHandler = handler;
        }
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
      id: 'temp-socket-error',
    };

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'ROOM_ERROR', myName: 'Bob' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Allow socket to be created
    await new Promise(resolve => setTimeout(resolve, 10));

    // Trigger the connect_error handler
    if (connectErrorHandler) {
      connectErrorHandler();
    }

    // Allow async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should NOT attempt to join on error
    expect(mockSocketInstance.emit).not.toHaveBeenCalledWith(
      'joinRoom',
      expect.any(Object)
    );

    // Should still clean up the socket
    expect(mockSocketInstance.disconnect).toHaveBeenCalled();

    mockSocketInstance = null;
  });

  it('ReconnectPopup (in-game disconnect) does not create temp socket', async () => {
    const { io } = await import('socket.io-client');
    const ioMock = vi.mocked(io);
    const initialIOCallCount = ioMock.mock.calls.length;

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    render(<App />);
    expect(screen.getByText('home.reconnect.title')).toBeInTheDocument();

    const returnButton = screen.getByText('home.reconnect.returnMenu');
    fireEvent.click(returnButton);

    // Popup should close
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();
    // Mode should switch to local (indicating intentional disconnect)
    expect(useGameStore.getState().mode).toBe('local');

    // No new temp socket should be created
    // (io call count should not increase beyond initial calls)
    expect(ioMock.mock.calls.length).toBe(initialIOCallCount);
  });
});
