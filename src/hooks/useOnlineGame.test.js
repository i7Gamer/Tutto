import { renderHook, act } from '@testing-library/react';
import { useOnlineGame } from './useOnlineGame';
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import * as socketIo from 'socket.io-client';

// Mock fetch for sendStats (global)
global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

// Mock socket.io-client
const mockEmit = vi.fn();
const mockOn = vi.fn();
vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => ({
      emit: mockEmit,
      on: mockOn,
      off: vi.fn(),
      disconnect: vi.fn(),
      id: 'socket-123',
    }))
  };
});

describe('useOnlineGame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets player statistics when starting a new game across multiple games', async () => {
    const { result } = renderHook(() => useOnlineGame('test-device'));

    // Join room
    let joinCallback;
    act(() => {
      const joinPromise = result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCallback = joinCall[2];
      joinCallback({ success: true, isHost: true, gameState: null, hostId: 'socket-123' });
    });

    act(() => {
      const mockState = {
        players: [
          { name: 'HostAlice', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0, feuerwerkBusts: 1, x2Busts: 1 },
          { name: 'PlayerBob', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0, feuerwerkBusts: 0, x2Busts: 0 }
        ],
        currentPlayerIndex: 0,
        currentCard: 'Kleeblatt',
        cards: [],
        round: 1,
        finished: false,
        gameTimeInSeconds: 0,
        initialCards: { "Kleeblatt": 1 },
        randomOrder: false,
        winningScore: 5000,
        chartValues: [[], []],
        chartNames: ['HostAlice', 'PlayerBob'],
        chartLabels: []
      };

      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) {
        gameStateCallback(mockState);
      }
    });

    expect(result.current.isHost).toBe(true);
    expect(result.current.myName).toBe('HostAlice');
    
    // Play turn and win instantly
    act(() => {
      result.current.nextTurn(0, true);
    });

    const pushStateCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    expect(pushStateCall).toBeDefined();
    
    const finishedState = pushStateCall[1].newState;
    expect(finishedState.finished).toBe(true);
    expect(finishedState.players[0].timesKleeblattCompleted).toBe(1);

    // Now start a new game
    act(() => {
      mockEmit.mockClear();
      result.current.startGame();
    });

    const startGamePushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    expect(startGamePushCall).toBeDefined();

    const newGameState = startGamePushCall[1].newState;
    // The previous stats should be reset to 0 in the new game state!
    expect(newGameState.players[0].timesKleeblattCompleted).toBe(0);
    expect(newGameState.players[0].totalTurns).toBe(0);
    expect(newGameState.players[0].busts).toBe(0);
    expect(newGameState.players[0].score).toBe(0);
    expect(newGameState.players[0].feuerwerkBusts).toBe(0);
    expect(newGameState.players[0].x2Busts).toBe(0);
    expect(newGameState.players[0].feuerwerkPointsScored).toBe(0);
    expect(newGameState.players[0].x2PointsScored).toBe(0);
    expect(newGameState.finished).toBe(false);
  });

  it('tracks Feuerwerk, x2, Stop and Plus/Minus points and busts during gameplay', () => {
    const { result } = renderHook(() => useOnlineGame('test-device'));

    act(() => {
      result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true, gameState: null, hostId: 'socket-123' });
    });

    const initialState = {
      players: [
        { name: 'HostAlice', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0, feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0, busts: 0, totalTurns: 0 }
      ],
      currentPlayerIndex: 0,
      currentCard: 'Feuerwerk',
      cards: [],
      round: 1,
      finished: false,
      gameTimeInSeconds: 0,
      initialCards: { "Feuerwerk": 1 },
      randomOrder: false,
      winningScore: 5000,
      chartValues: [[]],
      chartNames: ['HostAlice'],
      chartLabels: []
    };

    act(() => {
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) gameStateCallback(initialState);
    });

    // 1. Feuerwerk Points
    act(() => {
      mockEmit.mockClear();
      result.current.nextTurn(1500, false);
    });

    let pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    let state = pushCall[1].newState;
    expect(state.players[0].feuerwerkPointsScored).toBe(1500);
    expect(state.players[0].timesFeuerwerkReceived).toBe(1);
    expect(state.players[0].totalTurns).toBe(1);

    // Update local state mock to proceed
    act(() => {
      state.currentCard = 'x2'; // Set next card to x2
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) gameStateCallback(state);
    });

    // 2. x2 Bust
    act(() => {
      mockEmit.mockClear();
      result.current.nextTurn(0, false); // Bust on x2
    });

    pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    state = pushCall[1].newState;
    expect(state.players[0].x2Busts).toBe(1);
    expect(state.players[0].x2PointsScored).toBe(0);
    expect(state.players[0].timesx2Received).toBe(1);
    expect(state.players[0].busts).toBe(1);

    // Update local state mock to proceed
    act(() => {
      state.currentCard = 'Stop';
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) gameStateCallback(state);
    });

    // 3. Stop Card
    act(() => {
      mockEmit.mockClear();
      result.current.nextTurn(0, false); // Skip
    });

    pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    state = pushCall[1].newState;
    expect(state.players[0].timesSkipped).toBe(1);
    expect(state.players[0].busts).toBe(1); // Stop is not a bust!
  });

  it('submits correct statistics for all players when the game ends', () => {
    const { result } = renderHook(() => useOnlineGame('test-device'));

    act(() => {
      result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true, gameState: null, hostId: 'socket-123' });
    });

    const finishedState = {
      players: [
        { name: 'HostAlice', score: 999999, timesKleeblattCompleted: 1, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0 },
        { name: 'PlayerBob', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0 }
      ],
      currentPlayerIndex: 0,
      currentCard: 'Kleeblatt',
      cards: [],
      round: 1,
      finished: true,
      gameTimeInSeconds: 30,
      initialCards: { "Kleeblatt": 1 },
      randomOrder: false,
      winningScore: 5000,
      chartValues: [[], []],
      chartNames: ['HostAlice', 'PlayerBob'],
      chartLabels: []
    };

    act(() => {
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) {
        gameStateCallback(finishedState);
      }
    });

    const endGameStatsCall = mockEmit.mock.calls.find(call => call[0] === 'endGameStats');
    expect(endGameStatsCall).toBeDefined();

    const statsSent = endGameStatsCall[1].stats;
    expect(statsSent.gamesPlayed).toBe(1);
    expect(statsSent.wins).toBe(1);
    expect(statsSent.kleeblattCompleted).toBe(1);

    expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"totalKleeblattCompleted":1')
    }));
    
    // Check that it identified as a custom game
    const fetchCall1 = global.fetch.mock.calls.find(call => call[0] === '/api/stats/global');
    const payload1 = JSON.parse(fetchCall1[1].body);
    expect(payload1.isDefaultGame).toBe(false);
  });

  it('identifies default online game settings', () => {
    global.fetch.mockClear();
    mockOn.mockClear();
    mockEmit.mockClear();
    const { result } = renderHook(() => useOnlineGame('device456'));
    
    act(() => {
      result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true, gameState: null, hostId: 'socket-123' });
    });

    const defaultFinishedState = {
      players: [
        { name: 'HostAlice', score: 6000, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0 }
      ],
      currentPlayerIndex: 0,
      currentCard: 'Stop',
      cards: [],
      round: 1,
      finished: true,
      gameTimeInSeconds: 30,
      initialCards: {
        Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
        x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5
      },
      randomOrder: false,
      winningScore: 6000,
      chartValues: [[]],
      chartNames: ['HostAlice'],
      chartLabels: []
    };

    act(() => {
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) {
        gameStateCallback({ ...defaultFinishedState, finished: false });
        gameStateCallback(defaultFinishedState);
      }
    });

    const fetchCall2 = global.fetch.mock.calls.find(call => call[0] === '/api/stats/global' && JSON.parse(call[1].body).isDefaultGame === true);
    expect(fetchCall2).toBeDefined();
  });

  it('handles undo logic correctly to restore scores and previous cards', () => {
    const { result } = renderHook(() => useOnlineGame('device789'));
    
    act(() => {
      result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true, gameState: null, hostId: 'socket-123' });
    });

    const stateWithHistory = {
      players: [
        { name: 'HostAlice', score: 1000, totalTurns: 1, busts: 1, x2Busts: 1, timesx2Received: 1, x2PointsScored: 0 }
      ],
      currentPlayerIndex: 1,
      currentCard: 'Stop',
      previousCard: 'x2',
      previousScore: 0,
      cards: ['Stop'],
      round: 1,
      finished: false,
      gameTimeInSeconds: 30,
      initialCards: { "x2": 1, "Stop": 1 },
      randomOrder: false,
      winningScore: 6000,
      chartValues: [[1000]],
      chartNames: ['HostAlice'],
      chartLabels: ['1']
    };

    act(() => {
      const gameStateCallback = mockOn.mock.calls.find(call => call[0] === 'gameState')?.[1];
      if (gameStateCallback) {
        gameStateCallback(stateWithHistory);
      }
    });

    // Perform undo
    act(() => {
      mockEmit.mockClear();
      result.current.undo();
    });

    const pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    expect(pushCall).toBeDefined();
    
    const undoneState = pushCall[1].newState;
    expect(undoneState.currentPlayerIndex).toBe(0);
    expect(undoneState.currentCard).toBe('x2');
    expect(undoneState.previousCard).toBeNull();
    expect(undoneState.players[0].score).toBe(1000);
    expect(undoneState.players[0].totalTurns).toBe(0);
    expect(undoneState.players[0].busts).toBe(0);
    expect(undoneState.players[0].x2Busts).toBe(0);
    expect(undoneState.players[0].timesx2Received).toBe(0);
  });

  it('deep clones the players array during nextTurn and undo to ensure React detects leaderboard updates', () => {
    const { result } = renderHook(() => useOnlineGame('device1'));
    
    act(() => {
      // Simulate socket pushState to setup an active game
      const socketCall = mockOn.mock.calls.find(call => call[0] === 'gameState');
      const gameStateCallback = socketCall[1];
      
      gameStateCallback({
        players: [{ name: 'Alice', socketId: 'sock1', score: 1000 }, { name: 'Bob', socketId: 'sock2', score: 0 }],
        currentPlayerIndex: 0,
        currentCard: '200',
        cards: ['Stop'],
        round: 1,
        finished: false
      });
    });

    // Simulate becoming the host so we can perform actions
    act(() => {
      const hostCall = mockOn.mock.calls.find(call => call[0] === 'hostId');
      hostCall[1]('socket_id');
    });

    const initialPlayersRef = result.current.players;
    
    // Perform nextTurn
    act(() => {
      result.current.nextTurn(200, true);
    });

    const pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    const newState = pushCall[1].newState;
    
    // Ensure the players array reference changed
    expect(newState.players).not.toBe(initialPlayersRef);
    // Ensure the individual player object reference changed (deep clone)
    expect(newState.players[0]).not.toBe(initialPlayersRef[0]);
    expect(newState.players[0].score).toBe(1200);
  });

  it('updates config via setters and receives toast notifications', () => {
    const { result } = renderHook(() => useOnlineGame('test-device'));

    act(() => {
      const joinPromise = result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true });
    });

    act(() => {
      const socketCall = mockOn.mock.calls.find(call => call[0] === 'gameState');
      const gameStateCallback = socketCall[1];
      gameStateCallback({ winningScore: 5000, initialCards: {}, randomOrder: true, turnDuration: 60, reconnectTimeout: 60, players: [], status: 'lobby' });
    });

    mockEmit.mockClear();

    // Test setters
    act(() => result.current.setTurnDuration(45));
    expect(mockEmit).toHaveBeenCalledWith('updateConfig', expect.objectContaining({ turnDuration: 45 }));
    
    mockEmit.mockClear();
    act(() => result.current.setReconnectTimeout(120));
    expect(mockEmit).toHaveBeenCalledWith('updateConfig', expect.objectContaining({ reconnectTimeout: 120 }));

    mockEmit.mockClear();
    act(() => result.current.setWinningScore(7000));
    expect(mockEmit).toHaveBeenCalledWith('updateConfig', expect.objectContaining({ winningScore: 7000 }));
    
    mockEmit.mockClear();
    act(() => result.current.setInitialCards({ "200": 10 }));
    expect(mockEmit).toHaveBeenCalledWith('updateConfig', expect.objectContaining({ initialCards: { "200": 10 } }));

    // Test toast message
    act(() => {
      const socketCall = mockOn.mock.calls.find(call => call[0] === 'gameState');
      const gameStateCallback = socketCall[1];
      // initial was 60, now 30
      gameStateCallback({ winningScore: 5000, initialCards: {}, randomOrder: true, turnDuration: 30, reconnectTimeout: 60, players: [], status: 'lobby' });
    });
    
    expect(result.current.toastMessage).toContain('Host changed turn timer to 30s');

    act(() => result.current.clearToast());
    expect(result.current.toastMessage).toBe(null);
  });

  it('handles turn timer tick down and auto bust', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOnlineGame('test-device'));

    act(() => {
      result.current.joinRoom('1234', 'HostAlice');
      const joinCall = mockEmit.mock.calls.find(call => call[0] === 'joinRoom');
      joinCall[2]({ success: true, isHost: true });
      
      const hostCall = mockOn.mock.calls.find(call => call[0] === 'hostId');
      hostCall[1]('socket-123'); // HostAlice is host
    });

    act(() => {
      const socketCall = mockOn.mock.calls.find(call => call[0] === 'gameState');
      const gameStateCallback = socketCall[1];
      gameStateCallback({ 
        players: [{ name: 'HostAlice', score: 0 }], 
        currentPlayerIndex: 0, 
        turnDuration: 60,
        gameTimeInSeconds: 0,
        status: 'playing',
        cards: [],
        currentCard: null,
        initialCards: {},
        chartValues: [[]],
        chartLabels: [],
        chartNames: ['HostAlice']
      });
    });

    mockEmit.mockClear();

    expect(result.current.turnTimeRemaining).toBe(60);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.turnTimeRemaining).toBe(59);

    // Advance 59 seconds
    act(() => {
      vi.advanceTimersByTime(59000);
    });

    // Should have busted automatically
    expect(mockEmit).toHaveBeenCalledWith('pushState', expect.any(Object));
    const pushCall = mockEmit.mock.calls.find(call => call[0] === 'pushState');
    expect(pushCall[1].newState.currentPlayerIndex).toBe(0); // since it's 1 player it stays 0, but it triggers nextTurn
  });
});
