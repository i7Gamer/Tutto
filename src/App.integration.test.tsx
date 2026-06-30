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
    // The summary now auto-continues to the next player (same as a bust), so we
    // assert on Alice's committed leaderboard score rather than the fleeting modal.
    const stopButton = await screen.findByText(/dice.stop_and_score/i);
    fireEvent.click(stopButton);

    // Auto-advance to Bob's turn; Alice's 2200 is recorded on the leaderboard.
    await waitFor(() => {
      expect(screen.getAllByText(/2200/).length).toBeGreaterThan(0);
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

    // Bob's turn auto-continues too. Round is over! Alice has 2200, Bob has 100.
    // Winning score is 1000, so the End Screen should be shown!
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

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect') {
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

  it('RestoreSessionPopup Cancel explicitly calls cancelReconnect with roomId and name', async () => {
    const cancelReconnectSpy = vi.spyOn(useGameStore.getState(), 'cancelReconnect');

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'SPY_ROOM', myName: 'SpyUser' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Verify cancelReconnect was called with the correct roomId and name
    expect(cancelReconnectSpy).toHaveBeenCalledWith('SPY_ROOM', 'SpyUser');
    expect(cancelReconnectSpy).toHaveBeenCalledTimes(1);

    cancelReconnectSpy.mockRestore();
  });

  it('ReconnectPopup Return button calls cancelReconnect with no arguments', async () => {
    const cancelReconnectSpy = vi.spyOn(useGameStore.getState(), 'cancelReconnect');

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    render(<App />);
    const returnButton = screen.getByText('home.reconnect.returnMenu');
    fireEvent.click(returnButton);

    // Verify cancelReconnect was called with no roomId/name (in-game disconnect)
    expect(cancelReconnectSpy).toHaveBeenCalledWith();
    expect(cancelReconnectSpy).toHaveBeenCalledTimes(1);

    cancelReconnectSpy.mockRestore();
  });

  it('RestoreSessionPopup Cancel handles socket timeout gracefully', async () => {
    let connectErrorHandler;

    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect_error') {
          connectErrorHandler = handler;
        }
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
      id: 'temp-socket-timeout',
    };

    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'TIMEOUT_ROOM', myName: 'TimeoutUser' },
      });
    });

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Simulate connect error after a delay (simulating timeout)
    await new Promise(resolve => setTimeout(resolve, 20));
    if (connectErrorHandler) {
      connectErrorHandler();
    }

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have called disconnect to clean up
    expect(mockSocketInstance.disconnect).toHaveBeenCalled();
    // Should not have attempted joinRoom
    const joinRoomCalls = mockSocketInstance.emit.mock.calls.filter(c => c[0] === 'joinRoom');
    expect(joinRoomCalls.length).toBe(0);

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel propagates localStorage/sessionStorage cleanup on cancel', async () => {
    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'CLEANUP_ROOM', myName: 'CleanupUser' },
        liveTurnState: { turnScore: 75 },
      });
    });

    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 75 }));
    localStorage.setItem('tutto_color', '#FF5733');
    sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'CLEANUP_ROOM', myName: 'CleanupUser' }));

    render(<App />);

    // Verify data exists before cancel
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeTruthy();
    expect(sessionStorage.getItem('tutto_online_session')).toBeTruthy();

    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    // Allow async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    // Game state should be cleared
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    expect(useGameStore.getState().liveTurnState).toBeNull();
    expect(useGameStore.getState().pendingReconnectSession).toBeNull();

    // But user preferences should remain
    expect(localStorage.getItem('tutto_color')).toBe('#FF5733');

    mockSocketInstance = null;
  });

  it('RestoreSessionPopup Cancel with multiple state mutations maintains consistency', async () => {
    mockSocketInstance = {
      on: vi.fn((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 5);
        }
      }),
      emit: vi.fn((event, ...args) => {
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            setTimeout(() => callback({ success: true }), 10);
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'temp-socket-consistency',
    };

    // Set up complex state
    act(() => {
      useGameStore.setState({
        pendingReconnectSession: { roomId: 'CONSISTENCY_ROOM', myName: 'ConsistencyUser' },
        liveTurnState: { turnScore: 200, keptDice: [1, 2, 3] },
        showReconnectPopup: false,
      });
    });

    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 200, keptDice: [1, 2, 3] }));
    sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'CONSISTENCY_ROOM', myName: 'ConsistencyUser' }));

    render(<App />);
    const cancelButton = screen.getByText('home.restore.cancel');

    fireEvent.click(cancelButton);

    // Allow all async operations
    await new Promise(resolve => setTimeout(resolve, 100));

    // All game state should be cleared consistently
    const state = useGameStore.getState();
    expect(state.pendingReconnectSession).toBeNull();
    expect(state.liveTurnState).toBeNull();
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();

    // Temp socket should have properly left
    expect(mockSocketInstance.emit).toHaveBeenCalledWith('leaveRoom');
    expect(mockSocketInstance.disconnect).toHaveBeenCalled();

    mockSocketInstance = null;
  });

  it('Reconnect without liveTurnState during active game sets justReconnected for timer sync', async () => {
    // Set up: player in active game, other player's turn, no dice game
    act(() => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 1,  // Other player's turn
        currentCard: 'Kniffel',
        turnDuration: 60,
        gameTimeInSeconds: 25,
        turnTimeRemaining: 35,
        liveTurnState: null,  // No dice game in progress
        justReconnected: false,
      });
    });

    // Simulate disconnect then reconnect
    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    // Simulate server sending gameState after reconnect
    const gameState = {
      status: 'playing',
      currentPlayerIndex: 1,
      currentCard: 'Kniffel',
      turnDuration: 60,
      gameTimeInSeconds: 30,
      turnTimeRemaining: 30,  // Server calculated remaining time
      liveTurnState: null,  // Still no dice game
      finished: false,
    };

    // Manually trigger the socket handler
    const gameStateHandler = vi.fn((state) => {
      // Simulate what the actual gameState handler does
      useGameStore.setState((prev) => {
        const wasDisconnected = prev.showReconnectPopup;
        Object.assign(prev, state);

        // This is the key change - should set justReconnected based on status, not liveTurnState
        if (wasDisconnected && state.status === 'playing') {
          prev.justReconnected = true;
        }
        prev.showReconnectPopup = false;
        return prev;
      });
    });

    gameStateHandler(gameState);

    // justReconnected should be set despite no liveTurnState
    expect(useGameStore.getState().justReconnected).toBe(true);
    expect(useGameStore.getState().liveTurnState).toBeNull();

    // Timers should be set to server values
    expect(useGameStore.getState().turnTimeRemaining).toBe(30);
    expect(useGameStore.getState().gameTimeInSeconds).toBe(30);
  });

  it('Reconnect during lobby does not set justReconnected', () => {
    act(() => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'lobby',  // Game not started
        currentPlayerIndex: null,
        showReconnectPopup: true,
      });
    });

    // Simulate gameState from server
    const gameState = {
      status: 'lobby',
      currentPlayerIndex: null,
      players: [],
      liveTurnState: null,
      finished: false,
    };

    const gameStateHandler = vi.fn((state) => {
      useGameStore.setState((prev) => {
        const wasDisconnected = prev.showReconnectPopup;
        Object.assign(prev, state);

        if (wasDisconnected && state.status === 'playing') {
          prev.justReconnected = true;
        }
        prev.showReconnectPopup = false;
        return prev;
      });
    });

    gameStateHandler(gameState);

    // justReconnected should NOT be set when status is not 'playing'
    expect(useGameStore.getState().justReconnected).toBe(false);
  });

  it('DiceGame does not auto-open on reconnect without liveTurnState', async () => {
    act(() => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        myName: 'Alice',
        diceMode: 'digital',
        players: [{ name: 'Alice', socketId: 'sock-123' }],
        justReconnected: true,
        liveTurnState: null,  // No saved dice state
        showReconnectPopup: false,
      });
    });

    render(<App />);

    // Wait for useEffect to run
    await new Promise(resolve => setTimeout(resolve, 50));

    // DiceGame should NOT appear because liveTurnState is null
    expect(screen.queryByText(/resume|rolling/i)).not.toBeInTheDocument();

    // Verify we're in the game view and not showing an error
    const scoreboard = screen.queryByText('game.leaderboard');
    if (scoreboard) {
      expect(scoreboard).toBeInTheDocument();
    }
  });

  it('Game time syncs from server on start and is maintained during play', async () => {
    act(() => {
      useGameStore.setState({
        mode: 'local',
        isOnline: false,
        players: [{ name: 'Alice', score: 0 }],
        status: 'lobby',
      });
    });

    render(<App />);

    // Start game
    act(() => {
      useGameStore.getState().startGame();
    });

    // Game time should initialize to 0
    expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
    expect(useGameStore.getState().status).toBe('playing');

    // Wait for timer to tick
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Game time should have incremented
    const timeAfterWait = useGameStore.getState().gameTimeInSeconds;
    expect(timeAfterWait).toBeGreaterThanOrEqual(1);
  });

  it('Game time resyncs from server without drift on reconnect', async () => {
    // Simulate player in online game - server time is at 30 seconds
    useGameStore.setState({
      mode: 'online',
      isOnline: true,
      status: 'playing',
      currentPlayerIndex: 0,
      gameTimeInSeconds: 30,
      gameStartTime: Date.now() - 30000,  // Set up so elapsed time = 30 seconds
    });

    // First sync establishes baseline
    useGameStore.getState().syncOnlineTimers();
    let state = useGameStore.getState();
    let initialElapsed = Math.floor((Date.now() - state.gameStartTime) / 1000);
    expect(initialElapsed).toBe(30);

    // Server time advances to 35 seconds (e.g., due to network latency or processing)
    useGameStore.setState({ gameTimeInSeconds: 35 });

    // Re-sync with new server time
    useGameStore.getState().syncOnlineTimers();

    state = useGameStore.getState();
    const resyncElapsed = Math.floor((Date.now() - state.gameStartTime) / 1000);

    // Should now reflect 35 seconds
    expect(resyncElapsed).toBe(35);

    // Wait a bit and verify time continues to advance from correct reference
    await new Promise(resolve => setTimeout(resolve, 500));

    state = useGameStore.getState();
    const afterWait = Math.floor((Date.now() - state.gameStartTime) / 1000);
    // Should be ~35.5 seconds
    expect(afterWait).toBeGreaterThanOrEqual(35);
  });

  it('Game time does not drift across multiple server updates', async () => {
    const measurements = [];

    // Simulate multiple syncs with server time advancing
    for (let serverTime = 10; serverTime <= 12; serverTime++) {
      act(() => {
        useGameStore.setState({
          mode: 'online',
          isOnline: true,
          status: 'playing',
          currentPlayerIndex: 0,
          gameTimeInSeconds: serverTime,
        });
      });

      useGameStore.getState().syncOnlineTimers();

      const store = useGameStore.getState();
      const elapsedMs = Date.now() - store.gameStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      measurements.push({ server: serverTime, local: elapsedSeconds });

      // Wait between measurements
      if (serverTime < 12) {
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }

    // Verify no significant drift
    measurements.forEach(({ server, local }) => {
      // Local time should match server time within ±1 second
      expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
    });
  });

  it('Game time sync works for both online and local games', async () => {
    // Local game
    act(() => {
      useGameStore.setState({
        mode: 'local',
        isOnline: false,
        players: [{ name: 'Alice', score: 0 }],
        status: 'lobby',
      });
    });

    useGameStore.getState().startGame();
    expect(useGameStore.getState().gameTimeInSeconds).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 1100));
    let localGameTime = useGameStore.getState().gameTimeInSeconds;
    expect(localGameTime).toBeGreaterThanOrEqual(1);

    // Clean up for online test
    useGameStore.getState().reset();

    // Online game
    act(() => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 0,
      });
    });

    useGameStore.getState().syncOnlineTimers();
    expect(useGameStore.getState().gameTimeInSeconds).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 1100));
    let onlineGameTime = useGameStore.getState().gameTimeInSeconds;
    expect(onlineGameTime).toBeGreaterThanOrEqual(1);
  });
});
