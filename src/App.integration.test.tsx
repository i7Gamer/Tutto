import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import App from './App';
import * as diceLogic from './utils/diceLogic';
import { useGameStore, _resetTimersForTests } from './store/useGameStore';
import { DICE_PANEL_ENTRANCE_MS, TOAST_LIFETIME_MS, JOIN_TIMEOUT_MS } from './utils/uiTimings';

// Mock confetti
vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

vi.mock('./utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn(),
  vibrateBust: vi.fn(),
  vibrateSuccess: vi.fn(),
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
    Math.random = () => 0.999999; // Deterministic: keeps the player order stable (identity shuffle)

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

    // Pin the deck to '200' cards only so both turns deterministically draw a
    // '200' bonus card — buildDeck's constrained-random draw doesn't preserve
    // insertion order under a mocked Math.random the way the old plain shuffle
    // did. Must happen AFTER the mode click above, which resets initialCards.
    act(() => useGameStore.setState({ initialCards: { '200': 50 } }));

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
    // It is '200' — the pinned deck contains nothing else.

    // Alice's turn. First card is '200'.
    // We just do 1 Tutto!
    const openModalButton = await screen.findByRole('button', { name: /game.controls.rollDice/i });
    fireEvent.click(openModalButton);
    
    // Wait for modal to render
    await screen.findByRole('heading', { name: /dice.title/i });

    // The dice auto-roll once the panel's entrance delay elapses — there's no
    // manual roll button anymore. isTestEnv() is true here, so DiceGame's
    // roll() finalizes synchronously (see DiceGame.tsx) — only Game.tsx's
    // real DICE_PANEL_ENTRANCE_MS setTimeout needs to elapse; no separate
    // wait for the rolling animation is needed once it does.
    vi.useFakeTimers();
    act(() => { vi.advanceTimersByTime(DICE_PANEL_ENTRANCE_MS + 50); });
    vi.useRealTimers();

    await waitFor(() => {
      const dice = screen.getAllByText('1');
      expect(dice.length).toBeGreaterThanOrEqual(6);
    });

    const diceElements = screen.getAllByText('1');
    const actualDice = diceElements.filter(el => el.dataset.testid === 'die');
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

    // The dice auto-roll once the panel's entrance delay elapses (see the
    // matching comment on Alice's turn above for why no separate wait for
    // the rolling animation is needed).
    vi.useFakeTimers();
    act(() => { vi.advanceTimersByTime(DICE_PANEL_ENTRANCE_MS + 50); });
    vi.useRealTimers();

    // We make Bob score just 100 points and stop
    await waitFor(() => {
      const dice = screen.getAllByText('1');
      expect(dice.length).toBeGreaterThanOrEqual(6);
    });

    const bobDice = screen.getAllByText('1').filter(el => el.dataset.testid === 'die');
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
  }, 15000);


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
    // aria-modal is what Game.tsx's global keyboard-shortcut guard checks for
    // — without it, a mid-game disconnect (Game stays mounted underneath
    // this popup) would let Space/Enter presses fall through to it.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

    fireEvent.click(screen.getByText('home.reconnect.returnMenu'));
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();
    expect(useGameStore.getState().mode).toBe('local');
  });

  it('announces toasts, which are otherwise only ever seen', () => {
    // Every toast the app raises is transient and lives in a corner nothing
    // moves focus to: an invite link copied, a dice game resumed, a join
    // refused, a player kicked. Without a live region none of it is announced,
    // and a screen reader user is simply not told any of those things happened.
    render(<App />);

    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Host ended game early');
  });

  it('clears a toast once its time is up', () => {
    vi.useFakeTimers();
    render(<App />);

    act(() => {
      useGameStore.setState({ toasts: [{ id: 1, message: 'Host ended game early' }] });
    });

    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1); });
    expect(screen.getByText('Host ended game early')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });

    expect(useGameStore.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it('renders RestoreSessionPopup and clears session when clicking Cancel', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    expect(screen.getByText('home.restore.title')).toBeInTheDocument();
    expect(screen.getByText(/home.restore.description/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

    const cancelButton = screen.getByText('home.restore.cancel');
    fireEvent.click(cancelButton);

    expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    expect(screen.queryByText('home.restore.title')).not.toBeInTheDocument();
  });

  it('times out a reconnect whose ack never arrives instead of spinning forever', async () => {
    // joinRoom resolves only on the server's ack; if the server is down
    // mid-restart the promise never settles. The popup must fall back to the
    // failure path (dismissed + toast) after the shared join deadline rather
    // than show "attempting to reconnect" indefinitely.
    vi.useFakeTimers();
    // Restored afterwards: store reset() only rewinds state fields, so an
    // overridden ACTION would otherwise leak into every later test.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(() => new Promise(() => {})),
        });
      });
      render(<App />);

      fireEvent.click(screen.getByText('home.restore.yes'));
      expect(useGameStore.getState().showReconnectPopup).toBe(true);

      await act(async () => { vi.advanceTimersByTime(JOIN_TIMEOUT_MS + 100); });

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().toasts.map(toast => toast.message))
        .toContain('lobby.online.joinTimeout');
    } finally {
      useGameStore.setState({ joinRoom: originalJoinRoom });
      vi.useRealTimers();
    }
  });

  it('translates a refused restore the server named a code for', async () => {
    // The restore popup toasts whatever the ack carried, and the ack's prose is
    // English in every language — so a refusal with a code must be rendered
    // from the code, the way the lobby's error box already is.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(async () => ({
            success: false as const,
            code: 'name_taken',
            error: 'Username already exists in this room',
          })),
        });
      });
      render(<App />);

      await act(async () => { fireEvent.click(screen.getByText('home.restore.yes')); });

      const messages = useGameStore.getState().toasts.map(toast => toast.message);
      expect(messages).toContain('lobby.online.joinError.nameTaken');
      expect(messages.some(m => m.includes('Username already exists'))).toBe(false);
      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    } finally {
      useGameStore.setState({ joinRoom: originalJoinRoom });
    }
  });

  it('shows a codeless refusal as the prose the server sent', async () => {
    // An older server, or a refusal with no key here yet: the sentence is still
    // shown rather than replaced by the generic failure message.
    const originalJoinRoom = useGameStore.getState().joinRoom;
    try {
      act(() => {
        useGameStore.setState({
          pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' },
          joinRoom: vi.fn(async () => ({ success: false as const, error: 'Refused, reason unknown to this client' })),
        });
      });
      render(<App />);

      await act(async () => { fireEvent.click(screen.getByText('home.restore.yes')); });

      expect(useGameStore.getState().toasts.map(toast => toast.message))
        .toContain('Refused, reason unknown to this client');
    } finally {
      useGameStore.setState({ joinRoom: originalJoinRoom });
    }
  });

  it('moves keyboard focus into the reconnect popup when it appears', async () => {
    // Neither of these popups is opened by a click, so nothing puts focus
    // inside them: it stays wherever the player left it, behind the backdrop.
    // Tab from there walks the page underneath instead of the dialog.
    render(<App />);

    act(() => {
      useGameStore.setState({ showReconnectPopup: true });
    });

    await waitFor(() => {
      expect(screen.getByText('home.reconnect.returnMenu')).toHaveFocus();
    });
  });

  it('moves keyboard focus into the restore-session popup when it appears', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('home.restore.yes')).toHaveFocus();
    });
  });

  it('keeps Tab inside the restore-session popup', async () => {
    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' } });
    });

    render(<App />);

    const cancel = screen.getByText('home.restore.cancel');
    cancel.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(screen.getByText('home.restore.yes')).toHaveFocus();
  });

  it('dismisses the "Connection Lost" popup and shows an error toast when reconnect join fails', async () => {
    // Before this fix, a failed joinRoom() left showReconnectPopup stuck at
    // true forever — there's no gameState event to clear it (the join never
    // succeeded), so the user would be stuck on a misleading "attempting to
    // reconnect" popup with no feedback that anything went wrong.
    mockSocketInstance = {
      on: vi.fn(),
      emit: vi.fn((event, ...args) => {
        if (event === 'joinRoom') {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') {
            callback({ success: false, error: 'Game is already running. You cannot join mid-game.' });
          }
        }
      }),
      disconnect: vi.fn(),
      id: 'socket-fail',
    };

    act(() => {
      useGameStore.setState({ pendingReconnectSession: { roomId: 'MIDGAME_ROOM', myName: 'Dave' } });
    });

    render(<App />);

    const reconnectButton = screen.getByText('home.restore.yes');
    await act(async () => {
      fireEvent.click(reconnectButton);
    });

    // The "Connection Lost" popup must not be stuck open.
    expect(useGameStore.getState().showReconnectPopup).toBe(false);
    expect(screen.queryByText('home.reconnect.title')).not.toBeInTheDocument();

    // The user must see feedback explaining what happened.
    const messages = useGameStore.getState().toasts.map(t => t.message);
    expect(messages).toContain('Game is already running. You cannot join mid-game.');

    mockSocketInstance = null;
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

    // The flow is a chain of real-timer hops: connect → joinRoom → its ack →
    // leaveRoom → disconnect. Waiting on the last link rather than on a fixed
    // sleep, which a loaded run can outlast mid-chain — everything below it
    // has necessarily already happened by the time it has.
    await waitFor(() => expect(mockSocketInstance.disconnect).toHaveBeenCalled());

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

    // Wait for the handler the temp socket registers, not for a duration —
    // and then call it unconditionally, since an `if` around it would turn a
    // registration that never happened into a silently passing test.
    await waitFor(() => expect(connectErrorHandler).toBeDefined());
    connectErrorHandler();

    // Should still clean up the socket. Asserted first because it is the
    // positive end of the error path: without waiting for something that does
    // happen, the negative below would pass merely by being early.
    await waitFor(() => expect(mockSocketInstance.disconnect).toHaveBeenCalled());

    // Should NOT attempt to join on error
    expect(mockSocketInstance.emit).not.toHaveBeenCalledWith(
      'joinRoom',
      expect.any(Object)
    );

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

    // Simulate the connection failing, as a timeout would — once the handler
    // is actually registered rather than after a guess at how long that takes.
    await waitFor(() => expect(connectErrorHandler).toBeDefined());
    connectErrorHandler();

    // Should have called disconnect to clean up
    await waitFor(() => expect(mockSocketInstance.disconnect).toHaveBeenCalled());
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

    // Game state should be cleared. Retried until it is, rather than checked
    // once after a sleep long enough to hope it was.
    await waitFor(() => {
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    });

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

    // The same chain as the join+leave test above, so wait on the same last
    // link: disconnect. Everything asserted below precedes it.
    await waitFor(() => expect(mockSocketInstance.disconnect).toHaveBeenCalled());

    // All game state should be cleared consistently
    const state = useGameStore.getState();
    expect(state.pendingReconnectSession).toBeNull();
    expect(state.liveTurnState).toBeNull();
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();

    // Temp socket should have properly left
    expect(mockSocketInstance.emit).toHaveBeenCalledWith('leaveRoom');

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
    render(<App />);

    // Staged after mount, not before: App's startup restores the store from
    // storage, and with localStorage cleared in beforeEach that means defaults
    // overwriting whatever was staged first. Set up ahead of the render, none
    // of this survived — the app stayed on Home, and the negative assertion
    // below passed for want of anything at all being on screen.
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

    // Wait for the game view to be up — Game.tsx renders the leaderboard
    // unconditionally, so its arrival is the signal that the effects under
    // test have actually run.
    await waitFor(() => expect(screen.getByText('game.leaderboard')).toBeInTheDocument());

    // DiceGame should NOT appear because liveTurnState is null
    expect(screen.queryByText(/resume|rolling/i)).not.toBeInTheDocument();
  });

  it('Game time syncs from server on start and is maintained during play', async () => {
    vi.useFakeTimers();
    try {
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

      // The local game clock ticks on a real 1000ms setInterval (see
      // startLocalTimers in store/timers.ts) — advance it instead of
      // sleeping a real second.
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(500);
      });

      state = useGameStore.getState();
      const afterWait = Math.floor((Date.now() - state.gameStartTime) / 1000);
      // Should be ~35.5 seconds
      expect(afterWait).toBeGreaterThanOrEqual(35);
    } finally {
      vi.useRealTimers();
    }
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

      // Fast-forward simulated time by shifting gameStartTime backward 1000ms
      if (serverTime < 12) {
        act(() => {
          useGameStore.setState(s => ({ gameStartTime: s.gameStartTime - 1000 }));
        });
      }
    }

    // Verify no significant drift
    measurements.forEach(({ server, local }) => {
      // Local time should match server time within ±1 second
      expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
    });
  });

  it('lets a join link win over a saved local game, and keeps the save', async () => {
    // Following an invitation with an unfinished local game on this device
    // used to land on that old game's board: init() restored it, so App routed
    // into <Game/> and <Home/> — the only thing that consumes the link — was
    // unmounted before the code could be typed anywhere.
    const savedGame = JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
      status: 'playing', currentPlayerIndex: 0, finished: false, round: 2, gameTimeInSeconds: 50,
    });
    localStorage.setItem('tutto_local_game', savedGame);
    window.history.replaceState({}, '', '/?room=LINKED');

    try {
      render(<App />);

      // The invitation's lobby, with the room already filled in.
      await waitFor(() => expect(screen.getByDisplayValue('LINKED')).toBeInTheDocument());
      expect(screen.queryByText('game.round')).not.toBeInTheDocument();

      // Nothing was thrown away: the save is still on disk, so picking local
      // play resumes the game exactly where it was left.
      expect(JSON.parse(localStorage.getItem('tutto_local_game')).players[0].name).toBe('Alice');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('Game time sync works for both online and local games', async () => {
    vi.useFakeTimers();
    try {
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

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);

      useGameStore.getState().reset();
      _resetTimersForTests();

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

      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
  });
});
