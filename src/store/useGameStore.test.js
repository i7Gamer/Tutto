import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore } from './useGameStore';

let mockEmit = vi.fn();
let mockOnHandlers = {};
const mockDisconnect = vi.fn();

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => ({
      on: (event, handler) => {
        mockOnHandlers[event] = handler;
      },
      emit: mockEmit,
      off: vi.fn(),
      disconnect: mockDisconnect,
      id: 'socket-123',
    }))
  };
});

const makeOnlinePlayer = (name) => ({
  name, socketId: `sock-${name}`, deviceId: `dev-${name}`, score: 0,
  times1000PointsDeducted: 0, timesKniffelCompleted: 0, timesPlusMinusCompleted: 0,
  timesKniffelFailed: 0, timesKleeblattFailed: 0, timesKleeblattCompleted: 0,
  timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0, timesSkipped: 0,
  timesx2Received: 0, totalTurns: 0, busts: 0, feuerwerkBusts: 0, x2Busts: 0,
  feuerwerkPointsScored: 0, x2PointsScored: 0,
});

describe('useGameStore', () => {
  beforeEach(() => {
    // Reset state before each test
    useGameStore.getState().reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockEmit.mockClear();
  });

  it('initializes with default local state', () => {
    const state = useGameStore.getState();
    expect(state.mode).toBe('local');
    expect(state.isOnline).toBe(false);
    expect(state.players).toEqual([]);
    expect(state.round).toBe(1);
  });

  it('initializes from localStorage if available', () => {
    const storedState = { players: [{ name: 'Alice', color: '#ff0000', score: 100 }], round: 3 };
    localStorage.setItem('tutto_local_game', JSON.stringify(storedState));
    localStorage.setItem('tutto_diceMode', 'digital');

    useGameStore.getState().init('device-123');
    const state = useGameStore.getState();

    expect(state.deviceId).toBe('device-123');
    expect(state.players.length).toBe(1);
    expect(state.players[0].name).toBe('Alice');
    expect(state.round).toBe(3);
    expect(state.diceMode).toBe('digital');
  });

  it('adds and removes players', () => {
    useGameStore.getState().addPlayer('Player 1');
    useGameStore.getState().addPlayer('Player 2');

    let state = useGameStore.getState();
    expect(state.players.length).toBe(2);
    expect(state.players[0].name).toBe('Player 1');
    expect(state.players[0].color).toBeDefined();

    useGameStore.getState().removePlayer('Player 1');
    state = useGameStore.getState();
    expect(state.players.length).toBe(1);
    expect(state.players[0].name).toBe('Player 2');
  });

  it('updates configuration', () => {
    useGameStore.getState().setWinningScore(8000);
    useGameStore.getState().setTurnDuration(60);
    useGameStore.getState().setRandomOrder(false);

    const state = useGameStore.getState();
    expect(state.winningScore).toBe(8000);
    expect(state.turnDuration).toBe(60);
    expect(state.randomOrder).toBe(false);
  });

  it('changes player color locally', () => {
    useGameStore.getState().addPlayer('Alice');
    useGameStore.getState().changePlayerColor('Alice', '#FFFFFF');

    const state = useGameStore.getState();
    expect(state.players[0].color).toBe('#FFFFFF');
  });

  it('changes myColor and saves to localStorage', () => {
    useGameStore.setState({ myName: 'Bob' });
    useGameStore.getState().addPlayer('Bob');
    useGameStore.getState().changeMyColor('#123456');

    const state = useGameStore.getState();
    expect(state.players[0].color).toBe('#123456');
    expect(localStorage.getItem('tutto_color')).toBe('#123456');
  });

  it('starts local game', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    
    useGameStore.getState().startGame();

    const state = useGameStore.getState();
    expect(state.status).toBe('playing');
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0); // If randomOrder is true, it might be 0 or 1
    expect(state.round).toBe(1);
    expect(state.gameTimeInSeconds).toBe(0);
    expect(state.finished).toBe(false);
  });

  it('processes nextTurn', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({ status: 'playing', currentPlayerIndex: 0, round: 1 });
    
    // Simulate a successful turn
    useGameStore.getState().nextTurn(500, true);

    const state = useGameStore.getState();
    expect(state.previousCard).toBeDefined();
    // It should move to next player since it's a success
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.players[0].score).toBe(500);
  });

  it('processes undo', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.setState({ 
      status: 'playing', 
      currentPlayerIndex: 1, 
      previousCard: 'x2',
      previousScore: 0,
      previousLeaders: [],
      players: [{ name: 'P1', score: 500 }, { name: 'P2', score: 0 }] 
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    // It should revert back to P1
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.previousCard).toBeNull();
  });

  describe('local game stats saving', () => {
    it('does NOT send any stats when a local game ends', () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

      const store = useGameStore.getState();
      store.addPlayer('Alice');
      store.startGame();

      useGameStore.getState().nextTurn(6000, false);

      expect(useGameStore.getState().finished).toBe(true);
      expect(global.fetch).not.toHaveBeenCalledWith('/api/stats/global', expect.any(Object));
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/stats\//), expect.any(Object));

      global.fetch.mockRestore();
    });
  });

  describe('online game stats saving', () => {
    it('sends online stats for non-host when receiving finished gameState', () => {
      // Connect to online mode as non-host
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ isHost: false, roomId: 'ROOM1', myName: 'Bob', deviceId: 'dev-bob', players: [{name: 'Alice', times1000PointsDeducted: 0}, {name: 'Bob', times1000PointsDeducted: 0}], status: 'playing', finished: false });

      mockEmit.mockClear();

      // Simulate receiving a gameState that finishes the game
      if (mockOnHandlers['gameState']) {
        mockOnHandlers['gameState']({
          status: 'playing',
          finished: true,
          players: [{name: 'Alice', score: 6000}, {name: 'Bob', score: 2000}]
        });
      }

      // Should have emitted endGameStats with Bob's deviceId
      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-bob'
      }));
    });

    it('sends online stats exactly once when host finishes the game', () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ 
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', 
        players: [{name: 'Bob', score: 2000, times1000PointsDeducted: 0}, {name: 'Alice', score: 5500, times1000PointsDeducted: 0}],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {}
      });

      mockEmit.mockClear();

      // Host triggers winning turn
      useGameStore.getState().nextTurn(500, true);

      // Should emit endGameStats for Alice
      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-alice'
      }));

      // Should send global stats once
      expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.any(Object));

      global.fetch.mockRestore();
    });
  });

  describe('socket disconnect behavior', () => {
    it('sets showReconnectPopup when disconnected unexpectedly while online', () => {
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');

      // Ensure the 'disconnect' handler was registered
      expect(mockOnHandlers['disconnect']).toBeDefined();

      // Trigger unexpected disconnect
      mockOnHandlers['disconnect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('does NOT set showReconnectPopup when intentionally disconnecting by setting local mode', () => {
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');

      // Intentional disconnect (e.g. clicking "Leave" sets mode to local)
      useGameStore.getState().setMode('local');

      // Ensure mockDisconnect was called
      expect(mockDisconnect).toHaveBeenCalled();

      // Trigger 'disconnect' event (simulating what socket.io would do after disconnect() is called)
      if (mockOnHandlers['disconnect']) {
        mockOnHandlers['disconnect']();
      }

      // showReconnectPopup should be false because mode is local
      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    });
  });

  describe('online session recovery', () => {
    it('restores pendingReconnectSession from sessionStorage on init', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.getState().init('dev-123');
      
      const state = useGameStore.getState();
      expect(state.pendingReconnectSession).toEqual({ roomId: 'TEST_ROOM', myName: 'Alice' });
    });

    it('clears sessionStorage when leaving a room intentionally', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.getState().leaveRoom();
      
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    });

    it('clears sessionStorage when kicked from a room', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');

      // Trigger 'kicked'
      if (mockOnHandlers['kicked']) {
        // mock window.alert
        const originalAlert = window.alert;
        window.alert = vi.fn();
        
        mockOnHandlers['kicked']();
        
        expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
        window.alert = originalAlert;
      }
    });

    it('clears pendingReconnectSession when clearPendingReconnect is called', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));
      useGameStore.setState({ pendingReconnectSession: { roomId: 'TEST_ROOM', myName: 'Alice' } });

      useGameStore.getState().clearPendingReconnect();

      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
    });

    it('cancelReconnect (no args) clears showReconnectPopup and local state without connecting', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();

      useGameStore.setState({ showReconnectPopup: true, liveTurnState: { turnScore: 50 } });
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'R1', myName: 'Alice' }));
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 50 }));

      useGameStore.getState().cancelReconnect();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      // No temp socket opened — no roomId provided
      expect(io).not.toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) clears state and opens a temp socket to leave the room', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();

      useGameStore.setState({ pendingReconnectSession: { roomId: 'GHOST_ROOM', myName: 'Charlie' }, liveTurnState: { turnScore: 10 } });
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 10 }));

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(useGameStore.getState().pendingReconnectSession).toBeNull();
      expect(useGameStore.getState().liveTurnState).toBeNull();
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
      // Temp socket was created
      expect(io).toHaveBeenCalledWith(expect.any(String));

      // Simulate socket connecting and server accepting joinRoom
      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({ roomId: 'GHOST_ROOM', name: 'Charlie' });

      // Simulate successful joinRoom callback → should emit leaveRoom
      const joinCallback = joinRoomCall[2];
      joinCallback({ success: true });
      expect(mockEmit).toHaveBeenCalledWith('leaveRoom');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) does not emit leaveRoom if joinRoom fails', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(io).toHaveBeenCalledWith(expect.any(String));
      mockOnHandlers['connect']();

      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      const joinCallback = joinRoomCall[2];
      // Simulate failed joinRoom (success: false or server error)
      joinCallback({ success: false });

      // Should NOT emit leaveRoom on failure
      expect(mockEmit).not.toHaveBeenCalledWith('leaveRoom');
      // But should still disconnect to clean up the temp socket
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) cleans up on connect_error without trying to join', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('GHOST_ROOM', 'Charlie');

      expect(io).toHaveBeenCalledWith(expect.any(String));
      // Simulate connection failure
      mockOnHandlers['connect_error']();

      // Should not attempt to join
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeUndefined();
      // But should clean up
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('cancelReconnect(roomId, name) passes color from localStorage if available', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_color', '#FF5733');
      useGameStore.getState().cancelReconnect('ROOM_123', 'Alice');

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall[1]).toMatchObject({ color: '#FF5733' });
    });

    it('cancelReconnect handles missing deviceId gracefully', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      // Temporarily clear deviceId to test edge case
      const originalDeviceId = useGameStore.getState().deviceId;
      useGameStore.setState({ deviceId: null });

      useGameStore.getState().cancelReconnect('ROOM_XYZ', 'TestUser');

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      // Should still emit joinRoom even with null deviceId
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({
        roomId: 'ROOM_XYZ',
        name: 'TestUser',
        deviceId: null,
      });

      // Restore original deviceId
      useGameStore.setState({ deviceId: originalDeviceId });
    });

    it('cancelReconnect called multiple times creates multiple io socket attempts', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();

      const store = useGameStore.getState();

      // First call with roomId - creates temp socket
      store.cancelReconnect('ROOM_1', 'Alice');
      expect(io).toHaveBeenCalledTimes(1);

      // Second call with roomId - creates another temp socket
      store.cancelReconnect('ROOM_2', 'Bob');
      expect(io).toHaveBeenCalledTimes(2);

      // Call without roomId - does NOT create temp socket
      store.cancelReconnect();
      expect(io).toHaveBeenCalledTimes(2);

      // Verify handlers were registered for both socket attempts
      expect(mockOnHandlers['connect_error']).toBeDefined();
    });

    it('cancelReconnect cleans up socket after joinRoom callback with error', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();
      mockDisconnect.mockClear();

      useGameStore.getState().cancelReconnect('ROOM_FAIL', 'FailUser');

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      const callback = joinRoomCall[2];

      // Simulate error in callback (e.g., room no longer exists)
      callback({ success: false, error: 'Room not found' });

      // Should still disconnect even on error
      expect(mockDisconnect).toHaveBeenCalled();
      // Should not emit leaveRoom on failure
      expect(mockEmit).not.toHaveBeenCalledWith('leaveRoom');
    });

    it('cancelReconnect clears showReconnectPopup when called with no roomId', async () => {
      useGameStore.setState({
        showReconnectPopup: true,
        liveTurnState: { turnScore: 100 },
      });

      useGameStore.getState().cancelReconnect();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(useGameStore.getState().liveTurnState).toBeNull();
    });
  });

  // Orchestration behaviours that previously lived only in the removed
  // useOnlineGame / useGameLogic hooks.
  describe('startGame resets player statistics', () => {
    it('zeroes accumulated stats from a previous game', () => {
      const store = useGameStore.getState();
      store.addPlayer('Alice');
      // Pollute the player with stale stats.
      useGameStore.setState((s) => {
        Object.assign(s.players[0], {
          score: 5000, totalTurns: 9, busts: 3, feuerwerkBusts: 2,
          x2Busts: 1, feuerwerkPointsScored: 1500, x2PointsScored: 800,
          timesKleeblattCompleted: 1,
        });
      });

      useGameStore.getState().startGame();

      const p = useGameStore.getState().players[0];
      expect(p.score).toBe(0);
      expect(p.totalTurns).toBe(0);
      expect(p.busts).toBe(0);
      expect(p.feuerwerkBusts).toBe(0);
      expect(p.x2Busts).toBe(0);
      expect(p.feuerwerkPointsScored).toBe(0);
      expect(p.x2PointsScored).toBe(0);
      expect(p.timesKleeblattCompleted).toBe(0);
    });
  });

  describe('default vs custom game detection (global stats payload)', () => {
    const DEFAULT_CARDS = {
      Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
      x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
    };

    it('marks a 6000-point default-deck game as isDefaultGame: true', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 6000, initialCards: { ...DEFAULT_CARDS } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(true);
    });

    it('marks a tweaked deck as isDefaultGame: false', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 6000, initialCards: { ...DEFAULT_CARDS, Kleeblatt: 99 } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(false);
    });

    it('marks a non-6000 winning score as isDefaultGame: false', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.setState({ winningScore: 8000, initialCards: { ...DEFAULT_CARDS } });

      const payload = useGameStore.getState().buildGlobalStatsPayload();
      expect(payload.isDefaultGame).toBe(false);
    });
  });

  describe('online game global stats', () => {
    const DEFAULT_CARDS = {
      Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
      x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
    };

    it('host sends global stats when an online game ends', () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      useGameStore.getState().nextTurn(500, true);

      expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.any(Object));
      global.fetch.mockRestore();
    });

    it('non-host does NOT send global stats when an online game ends', () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      useGameStore.getState().nextTurn(500, true);

      expect(global.fetch).not.toHaveBeenCalledWith('/api/stats/global', expect.any(Object));
      global.fetch.mockRestore();
    });
  });

  describe('online config-change toasts', () => {
    it('toasts when the host changes the winning score in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ status: 'lobby', winningScore: 6000 });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 8000, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('8000'))).toBe(true);
    });
  });

  describe('online turn timer', () => {
    it('host auto-busts the active player when the turn timer expires', () => {
      vi.useFakeTimers();
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        turnDuration: 2, currentCard: '200', cards: ['200'], initialCards: { 200: 5 },
        round: 1, chartValues: [[], []], chartLabels: [], chartNames: ['Alice', 'Bob'],
      });

      // Kick the turn timer off as syncOnlineTimers would after a state push.
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(2);

      mockEmit.mockClear();
      vi.advanceTimersByTime(2000);

      // Auto-bust advances the turn and pushes the new state to the server.
      expect(mockEmit).toHaveBeenCalledWith('pushState', expect.any(Object));
      expect(useGameStore.getState().currentPlayerIndex).toBe(1);
      vi.useRealTimers();
    });
  });

  describe('liveTurnState', () => {
    it('setLiveTurnState stores the snapshot locally', () => {
      const snapshot = { turnScore: 200, keptDice: [{ val: 1 }], currentRoll: [] };
      useGameStore.getState().setLiveTurnState(snapshot);
      expect(useGameStore.getState().liveTurnState).toEqual(snapshot);
    });

    it('setLiveTurnState triggers pushState when online', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 0, status: 'playing',
      });
      mockEmit.mockClear();

      const snapshot = { turnScore: 350, keptDice: [{ val: 5 }], currentRoll: [{ val: 3, selected: false }] };
      useGameStore.getState().setLiveTurnState(snapshot);

      expect(mockEmit).toHaveBeenCalledWith('pushState', expect.objectContaining({
        newState: expect.objectContaining({ liveTurnState: snapshot }),
      }));
    });

    it('nextTurn clears liveTurnState', () => {
      useGameStore.getState().addPlayer('P1');
      useGameStore.getState().addPlayer('P2');
      useGameStore.setState({
        status: 'playing', currentPlayerIndex: 0, round: 1,
        liveTurnState: { turnScore: 100, keptDice: [], currentRoll: [] },
      });

      useGameStore.getState().nextTurn(500, true);

      expect(useGameStore.getState().liveTurnState).toBeNull();
    });

    it('endGame clears liveTurnState', () => {
      useGameStore.setState({
        liveTurnState: { turnScore: 100, keptDice: [], currentRoll: [] },
      });

      useGameStore.getState().endGame();

      expect(useGameStore.getState().liveTurnState).toBeNull();
    });
  });

  describe('Plus_Minus store integration', () => {
    const makeP = (name, score = 0) => ({
      name, score, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
      timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
      timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
      timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
      feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
      position: 0,
    });

    it('deducts 1000 from leader with exactly 1000 pts when non-leader plays Plus_Minus', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 1, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200', '300'], chartValues: [[], []], chartLabels: [],
      });

      useGameStore.getState().nextTurn(0, true);

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(0);    // Alice: 1000 - 1000
      expect(s.players[1].score).toBe(1000); // Bob: 0 + 1000
      expect(s.players[0].times1000PointsDeducted).toBe(1);
      expect(s.previousLeaders).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Alice', score: 1000 }),
      ]));
      expect(s.previousCard).toBe('Plus_Minus');
      expect(s.previousScore).toBe(1000);
    });

    it('undo restores leader from 0 back to exactly 1000 after Plus_Minus', () => {
      // State after Bob played Plus_Minus: Alice=0, Bob=1000, now Alice's turn (round 2)
      useGameStore.setState({
        status: 'playing', round: 2, finished: false,
        currentPlayerIndex: 0, currentCard: '200',
        players: [
          makeP('Alice', 0),
          { ...makeP('Bob', 1000), totalTurns: 1, timesPlusMinusCompleted: 1 },
        ],
        cards: ['300'],
        chartValues: [[0], [1000]], chartLabels: [1],
        previousCard: 'Plus_Minus',
        previousScore: 1000,
        previousLeaders: [{ name: 'Alice', score: 1000, times1000PointsDeducted: 0, timesKniffelCompleted: 0, timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0, timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0, timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0, feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0, position: 0 }],
        previousWasBust: false,
        previousHighestTurnScore: 0,
      });

      useGameStore.getState().undo();

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(1000); // Alice restored to 1000
      expect(s.players[1].score).toBe(0);    // Bob loses his 1000
      expect(s.players[0].times1000PointsDeducted).toBe(0);
      expect(s.players[1].timesPlusMinusCompleted).toBe(0);
      expect(s.previousCard).toBeNull();
      expect(s.previousLeaders).toBeNull();
      expect(s.currentPlayerIndex).toBe(1); // back to Bob's turn
    });

    it('full nextTurn then undo round-trip for leader at exactly 1000', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 1, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200'], chartValues: [[], []], chartLabels: [],
        previousCard: null, previousScore: null, previousLeaders: null,
        previousWasBust: false, previousHighestTurnScore: 0,
      });

      useGameStore.getState().nextTurn(0, true);

      let s = useGameStore.getState();
      expect(s.players[0].score).toBe(0);
      expect(s.players[1].score).toBe(1000);

      useGameStore.getState().undo();

      s = useGameStore.getState();
      expect(s.players[0].score).toBe(1000); // Alice fully restored
      expect(s.players[1].score).toBe(0);    // Bob fully reversed
    });

    it('does NOT deduct when card holder is the leader at exactly 1000', () => {
      useGameStore.setState({
        status: 'playing', round: 1, finished: false,
        currentPlayerIndex: 0, currentCard: 'Plus_Minus',
        players: [makeP('Alice', 1000), makeP('Bob', 0)],
        cards: ['200', '300'], chartValues: [[], []], chartLabels: [],
      });

      useGameStore.getState().nextTurn(0, true);

      const s = useGameStore.getState();
      expect(s.players[0].score).toBe(2000); // Alice: 1000 + 1000, no deduction
      expect(s.players[1].score).toBe(0);    // Bob untouched
      expect(s.previousLeaders).toBeNull();  // no snapshot because no deduction
    });
  });

  describe('disconnect toast', () => {
    it('includes the reconnect countdown in the toast', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ reconnectTimeout: 45 });

      mockOnHandlers['playerDisconnected']('Bob');

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Bob') && m.includes('45 seconds'))).toBe(true);
    });
  });

  describe('Dice Game State Persistence', () => {
    it('setLiveTurnState saves state to localStorage', () => {
      const turnState = {
        turnScore: 1250,
        keptDice: [{ id: 'die-1', val: 1 }],
        currentRoll: [{ id: 'die-2', val: 6, selected: true }],
        rollingDiceIds: ['die-3']
      };

      useGameStore.getState().setLiveTurnState(turnState);

      const saved = localStorage.getItem('tutto_dice_turn_state');
      expect(saved).toBeDefined();
      expect(JSON.parse(saved)).toEqual(turnState);
    });

    it('setLiveTurnState does not save null state to localStorage', () => {
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 100 }));

      useGameStore.getState().setLiveTurnState(null);

      const saved = localStorage.getItem('tutto_dice_turn_state');
      expect(saved).toBe(JSON.stringify({ turnScore: 100 })); // Should not be cleared by null
    });

    it('nextTurn clears dice game state from localStorage', () => {
      // Setup initial state
      useGameStore.setState({
        players: [
          { name: 'Alice', deviceId: 'dev-alice', score: 0, busts: 0, totalTurns: 0,
            times1000PointsDeducted: 0, timesKniffelCompleted: 0, timesPlusMinusCompleted: 0,
            timesKniffelFailed: 0, timesKleeblattFailed: 0, timesKleeblattCompleted: 0,
            timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0, timesSkipped: 0,
            timesx2Received: 0, feuerwerkBusts: 0, x2Busts: 0,
            feuerwerkPointsScored: 0, x2PointsScored: 0, highestTurnScore: 0, position: 1, color: '#ff0000'
          }
        ],
        currentPlayerIndex: 0,
        currentCard: 'Feuerwerk',
        cards: [1, 2, 3, 4, 5, 6],
        round: 1
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 500 }));

      useGameStore.getState().nextTurn(500, true);

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('endGame clears dice game state from localStorage', () => {
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 750 }));

      useGameStore.getState().endGame();

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });
  });

});
