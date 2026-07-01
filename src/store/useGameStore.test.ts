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

  it('ignores a non-object localStorage value instead of corrupting state', () => {
    // A valid-JSON-but-not-an-object value (e.g. a leftover string) must not be
    // Object.assign'd into state. Previously JSON.parse('"corrupt"') → "corrupt"
    // would spread string indices into the store.
    localStorage.setItem('tutto_local_game', '"corrupt"');
    useGameStore.getState().init('device-123');
    const state = useGameStore.getState();
    expect(state.players).toEqual([]);
    expect(state.deviceId).toBe('device-123');
  });

  it('re-anchors the game clock when restoring an in-progress local game', () => {
    // Saved games persist elapsed seconds, not an absolute start time. Restoring an
    // in-progress game must re-anchor gameStartTime so the timer continues instead of
    // freezing (regression: gameStartTime stayed null → tick no-ops → clock frozen).
    const storedState = {
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }, { name: 'Bob', color: '#00ff00', score: 50 }],
      status: 'playing',
      currentPlayerIndex: 0,
      finished: false,
      round: 2,
      gameTimeInSeconds: 50,
    };
    localStorage.setItem('tutto_local_game', JSON.stringify(storedState));

    const before = Date.now();
    useGameStore.getState().init('device-xyz');
    const state = useGameStore.getState();

    expect(state.gameStartTime).not.toBeNull();
    // Anchored to ~now - 50s, so the derived elapsed continues from ~50.
    const elapsed = Math.floor((before - (state.gameStartTime as number)) / 1000);
    expect(elapsed).toBeGreaterThanOrEqual(49);
    expect(elapsed).toBeLessThanOrEqual(51);
  });

  it('does not re-anchor the clock when the restored local game is not in progress', () => {
    localStorage.setItem('tutto_local_game', JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 0 }],
      status: 'lobby',
      currentPlayerIndex: null,
      finished: false,
      gameTimeInSeconds: 0,
    }));
    useGameStore.getState().init('device-xyz');
    expect(useGameStore.getState().gameStartTime).toBeNull();
  });

  it('does not rewrite localStorage on a pure game-timer tick, but does on a real change', () => {
    useGameStore.getState().addPlayer('Alice');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    // Simulate a 1s timer tick: only gameTimeInSeconds changes → must NOT persist.
    useGameStore.setState({ gameTimeInSeconds: 999 });
    const writesAfterTick = setItemSpy.mock.calls.filter(c => c[0] === 'tutto_local_game').length;
    expect(writesAfterTick).toBe(0);

    // A real state change (new player) must persist.
    useGameStore.getState().addPlayer('Bob');
    const writesAfterChange = setItemSpy.mock.calls.filter(c => c[0] === 'tutto_local_game').length;
    expect(writesAfterChange).toBeGreaterThan(0);

    setItemSpy.mockRestore();
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

      // Should emit endGameStats for Alice (personal stats via socket)
      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-alice'
      }));

      // Should emit global stats via socket (no HTTP token needed)
      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', expect.objectContaining({
        roomId: 'ROOM1',
      }));
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

    it('sets justReconnected when reconnecting with active game (status=playing), independent of liveTurnState', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        showReconnectPopup: true,
        status: 'playing',
        currentPlayerIndex: 1,
        liveTurnState: null,  // Explicitly no dice game in progress
      });

      // Simulate incoming gameState while disconnected
      const newState = {
        status: 'playing',
        currentPlayerIndex: 1,
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        liveTurnState: null,  // Still no dice game
        gameTimeInSeconds: 45,
        turnTimeRemaining: 30,
      };

      // Simulate socket.io 'gameState' event
      mockOnHandlers['gameState'](newState);

      // justReconnected should be set despite no liveTurnState
      expect(useGameStore.getState().justReconnected).toBe(true);
      expect(useGameStore.getState().liveTurnState).toBeNull();
    });

    it('does NOT set justReconnected when reconnecting with non-playing status', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        showReconnectPopup: true,
        status: 'lobby',  // Game not started
        currentPlayerIndex: null,
      });

      const newState = {
        status: 'lobby',
        currentPlayerIndex: null,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
      };

      mockOnHandlers['gameState'](newState);

      // justReconnected should NOT be set when status is not 'playing'
      expect(useGameStore.getState().justReconnected).toBe(false);
    });

    it('timer sync uses server turnTimeRemaining even without liveTurnState (same ongoing turn)', () => {
      // Prime internal tracking so player=0/card=Kniffel is the "known" turn
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, gameTimeInSeconds: 20,
        liveTurnState: null, justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers();

      // Simulate reconnect: same player, same card, server sends remaining=25
      useGameStore.setState({
        justReconnected: true,
        turnTimeRemaining: 25,  // Server calculated: 60 - 35 elapsed = 25 remaining
      });

      useGameStore.getState().syncOnlineTimers();

      // Same turn + reconnect → timer must use server's remaining time (25), not full 60
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);
    });

    it('justReconnected flag persists after syncOnlineTimers — reset is handled by Game.jsx effect', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        currentCard: 'Stop',
        turnDuration: 60,
        gameTimeInSeconds: 10,
        gameStartTime: Date.now() - 10000,
        liveTurnState: null,
        justReconnected: true,
      });

      useGameStore.getState().syncOnlineTimers();

      // syncOnlineTimers must NOT clear justReconnected — Game.jsx's useEffect does that
      // after opening the DiceGame (or skipping when liveTurnState is null)
      expect(useGameStore.getState().justReconnected).toBe(true);
    });

    it('does NOT set justReconnected on a normal gameState update (not a reconnect)', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        showReconnectPopup: false,  // Not disconnected — normal steady-state
        status: 'playing',
        currentPlayerIndex: 0,
        justReconnected: false,
      });

      const newState = {
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
        gameTimeInSeconds: 15,
        turnTimeRemaining: 45,
      };

      mockOnHandlers['gameState'](newState);

      // Most gameState events are NOT reconnects — justReconnected must stay false
      expect(useGameStore.getState().justReconnected).toBe(false);
    });

    it('syncOnlineTimers uses full turn duration when NOT reconnecting (justReconnected=false)', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        currentCard: 'Kniffel',
        turnDuration: 60,
        turnTimeRemaining: 5,   // Stale leftover from previous countdown
        justReconnected: false, // Normal new turn — not a reconnect
      });

      useGameStore.getState().syncOnlineTimers();

      // Must reset to full duration (60), not re-use the stale 5
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('syncOnlineTimers uses server turnTimeRemaining when justReconnected=true AND same player/card (ongoing turn)', () => {
      // turnTimerPlayerIndex/Card start null, so first call always sets them — we need
      // to prime the internal state by running a first sync, then simulate a reconnect
      // where player + card are unchanged.
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 40,
        justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers(); // prime internal tracking vars

      // Now simulate reconnect: same player, same card, justReconnected=true
      useGameStore.setState({ justReconnected: true, turnTimeRemaining: 25 });
      useGameStore.getState().syncOnlineTimers();

      // Same turn + reconnect → use server's remaining time (25), not full duration (60)
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);
    });

    it.each([
      ['Feuerwerk', 3],
      ['Kleeblatt', 2],
      ['200',       1],
      ['Stop',      1],
    ])('syncOnlineTimers applies %s turn multiplier (%dx)', (card, multiplier) => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: card,
        turnDuration: 60, justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60 * multiplier);
    });

    it('stopOnlineTimers clears both game and turn timer state', () => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 30,
      });
      useGameStore.getState().syncOnlineTimers(); // start timers
      useGameStore.getState().stopOnlineTimers();
      // turnTimeRemaining is NOT reset by stopOnlineTimers (only by syncOnlineTimers/setMode)
      // but the internal interval tracking vars should be cleared — verified indirectly:
      // a subsequent syncOnlineTimers must treat the card as "new" and reset to full duration.
      useGameStore.setState({ turnTimeRemaining: 5 });
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    it('syncOnlineTimers uses full turn duration when justReconnected=true but player changed (new turn)', () => {
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0, currentCard: 'Kniffel',
        turnDuration: 60, turnTimeRemaining: 3, // nearly-expired from previous turn
        justReconnected: false,
      });
      useGameStore.getState().syncOnlineTimers(); // prime: player=0, card=Kniffel

      // New turn starts while justReconnected is still true
      useGameStore.setState({ currentPlayerIndex: 1, justReconnected: true, turnTimeRemaining: 3 });
      useGameStore.getState().syncOnlineTimers();

      // playerChanged=true must win over justReconnected → full duration, not 3
      expect(useGameStore.getState().turnTimeRemaining).toBe(60);
    });

    describe('server-authoritative game time sync', () => {
    it('startGame initializes gameTimeInSeconds to 0', () => {
      useGameStore.setState({
        mode: 'local',
        isOnline: false,
        players: [{ name: 'Alice', score: 0 }],
      });

      useGameStore.getState().startGame();

      expect(useGameStore.getState().gameTimeInSeconds).toBe(0);
      expect(useGameStore.getState().status).toBe('playing');
    });

    it('syncOnlineTimers sets gameStartTime from server gameTimeInSeconds', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45,  // Server says 45 seconds elapsed
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // Compute elapsed AFTER sync so both Date.now() calls are nearly simultaneous
      const state = useGameStore.getState();
      const elapsedSeconds = Math.floor((Date.now() - state.gameStartTime) / 1000);
      expect(elapsedSeconds).toBe(45);
    });

    it('local timer increments between server syncs', async () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 10,
        turnDuration: 60,
      });

      useGameStore.getState().syncOnlineTimers();
      const initialTime = useGameStore.getState().gameTimeInSeconds;

      // Wait for 1 second
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Timer should have incremented by ~1
      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initialTime + 1);
    });

    it('reconnect syncs gameStartTime from new server gameTimeInSeconds value', async () => {
      // Simulate: game started 30 seconds ago from server's perspective
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 30,
        gameStartTime: Date.now() - 30000,
      });

      useGameStore.getState().syncOnlineTimers();

      // Server sends updated state: now 35 seconds elapsed
      const newServerTime = 35;
      useGameStore.setState({ gameTimeInSeconds: newServerTime });

      // Resync with new server value
      useGameStore.getState().syncOnlineTimers();

      const state = useGameStore.getState();
      const elapsedMs = Date.now() - state.gameStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      // Should reflect new server time (35 seconds)
      expect(elapsedSeconds).toBe(newServerTime);
    });

    it('game time does not drift on repeated syncs', async () => {
      const syncTimes = [];

      // Simulate 3 syncs over 2+ seconds
      for (let i = 0; i < 3; i++) {
        const serverTime = 10 + i;  // Server advances: 10, 11, 12
        useGameStore.setState({
          mode: 'online',
          isOnline: true,
          status: 'playing',
          currentPlayerIndex: 0,
          gameTimeInSeconds: serverTime,
        });

        useGameStore.getState().syncOnlineTimers();
        const state = useGameStore.getState();
        const elapsedMs = Date.now() - state.gameStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);

        syncTimes.push({ server: serverTime, local: elapsedSeconds });

        // Wait between syncs
        if (i < 2) await new Promise(resolve => setTimeout(resolve, 1100));
      }

      // Verify no large drifts between server and local times
      syncTimes.forEach(({ server, local }) => {
        expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
      });
    });

    it('game timer respects gameStartTime being set', () => {
      const targetTime = 25;
      const now = Date.now();

      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: targetTime,
        gameStartTime: now - (targetTime * 1000),  // Pre-calculated start time
      });

      // Manual interval tick
      const s = useGameStore.getState();
      if (s.gameStartTime) {
        const calculated = Math.floor((Date.now() - s.gameStartTime) / 1000);
        expect(calculated).toBe(targetTime);
      }
    });

    it('does not set gameStartTime if gameTimeInSeconds is null', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: null,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // gameStartTime should remain null
      expect(useGameStore.getState().gameStartTime).toBeNull();
    });

    it('does not set gameStartTime if gameTimeInSeconds is negative', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: -1,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();

      // gameStartTime should remain null
      expect(useGameStore.getState().gameStartTime).toBeNull();
    });

    it('does not reset gameStartTime when server lag is ≤2s (prevents backward timer jump on opponent turns)', () => {
      // Client has been running for 46s locally; server sends 45 (1s behind due to Math.floor)
      const originalStart = Date.now() - 46000;
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45, // server value: 1s behind client
        gameStartTime: originalStart,
      });

      useGameStore.getState().syncOnlineTimers();

      // Drift is 1s ≤ 2s threshold → gameStartTime must NOT be reset
      expect(useGameStore.getState().gameStartTime).toBe(originalStart);
    });

    it('resets gameStartTime when drift exceeds 2s (reconnect or true clock divergence)', () => {
      // Client has stale gameStartTime showing 10s; server says 45s (reconnect scenario)
      const staleStart = Date.now() - 10000;
      useGameStore.setState({
        mode: 'online', isOnline: true, status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 45, // server value: 35s ahead of stale local
        gameStartTime: staleStart,
      });

      useGameStore.getState().syncOnlineTimers();

      // Drift is 35s > 2s threshold → gameStartTime must be updated
      const newStart = useGameStore.getState().gameStartTime;
      expect(newStart).not.toBe(staleStart);
      const newElapsed = Math.floor((Date.now() - newStart) / 1000);
      expect(newElapsed).toBe(45);
    });

    it('game timer increments correctly via gameStartTime reference', async () => {
      // gameTimeInSeconds=0 → syncOnlineTimers sets gameStartTime → interval uses that path
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: 0,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();
      const initial = useGameStore.getState().gameTimeInSeconds;

      await new Promise(resolve => setTimeout(resolve, 1100));

      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initial + 1);
    });

    it('game timer does not tick when gameStartTime is null (null gameTimeInSeconds skips anchor)', async () => {
      // gameTimeInSeconds=null → syncOnlineTimers cannot anchor gameStartTime → timer fires but does nothing
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        status: 'playing',
        currentPlayerIndex: 0,
        gameTimeInSeconds: null,
        gameStartTime: null,
      });

      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().gameStartTime).toBeNull(); // Confirm no anchor was set

      await new Promise(resolve => setTimeout(resolve, 1100));

      // Without gameStartTime the timer interval has nothing to compute — value stays null.
      expect(useGameStore.getState().gameTimeInSeconds).toBeNull();
    });
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

    it('cancelReconnect disconnects socket after 10s if joinRoom callback never fires', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockDisconnect.mockClear();

      vi.useFakeTimers();

      useGameStore.getState().cancelReconnect('ROOM_TIMEOUT', 'Ghost');

      // Socket connects but server never calls the joinRoom callback
      mockOnHandlers['connect']();

      // Before timeout: not yet disconnected
      vi.advanceTimersByTime(9999);
      expect(mockDisconnect).not.toHaveBeenCalled();

      // At 10s: failsafe fires and disconnects
      vi.advanceTimersByTime(1);
      expect(mockDisconnect).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('cancelReconnect clears the timeout when joinRoom callback fires normally', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockDisconnect.mockClear();

      vi.useFakeTimers();

      useGameStore.getState().cancelReconnect('ROOM_OK', 'Alice');
      mockOnHandlers['connect']();

      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      const callback = joinRoomCall[2];

      // Callback fires well before the 10s timeout
      callback({ success: true });
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Advancing past 10s must NOT trigger a second disconnect
      vi.advanceTimersByTime(15000);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
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
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      mockEmit.mockClear();
      useGameStore.getState().nextTurn(500, true);

      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', expect.objectContaining({
        roomId: 'ROOM1',
      }));
    });

    it('non-host does NOT send global stats when an online game ends', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ ...makeOnlinePlayer('Alice'), score: 5500 }],
        currentPlayerIndex: 0, status: 'playing', finished: false,
        winningScore: 6000, initialCards: { ...DEFAULT_CARDS },
      });

      mockEmit.mockClear();
      useGameStore.getState().nextTurn(500, true);

      expect(mockEmit).not.toHaveBeenCalledWith('submitGlobalStats', expect.any(Object));
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
