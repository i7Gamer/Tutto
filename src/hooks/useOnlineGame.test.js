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
          { name: 'HostAlice', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0 },
          { name: 'PlayerBob', score: 0, timesKleeblattCompleted: 0, timesKleeblattFailed: 0, timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0, timesKniffelCompleted: 0, timesKniffelFailed: 0, timesSkipped: 0, timesFeuerwerkReceived: 0, timesx2Received: 0, times1000PointsDeducted: 0 }
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
    expect(newGameState.finished).toBe(false);
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
});
