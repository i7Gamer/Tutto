import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, _resetTimersForTests } from './useGameStore';
import { disconnectSocket } from './socketRef';
import { DEFAULT_INITIAL_CARDS } from '../utils/configValidation';
import { blockStorage, failStorageMethods, restoreStorage } from '../testing/storageStubs';
import { JOIN_TIMEOUT_MS } from '../utils/uiTimings';
import type { Player } from '../types';

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

// Minimal player stand-ins for tests that only ever read `name`.
const namedPlayers = (...names: string[]): Player[] =>
  names.map(name => ({ name }) as unknown as Player);

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
    // reset() only resets Zustand state — the module-level gameTimerInterval/
    // turnTimerInterval aren't part of that state, so a timer started in one
    // test can otherwise keep firing into the next (vitest caches the module
    // between test cases within the same file).
    _resetTimersForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockEmit.mockClear();
  });

  describe('default deck isolation', () => {
    // configValidation.ts states the rule outright: consumers that keep these
    // defaults in mutable state must copy them. Handing the store the shared
    // object means any in-place write — from any path Immer does not own —
    // silently rewrites the defaults for the whole app for the rest of the
    // session, and every later "reset to defaults" lands on the corrupted deck.
    // setMode already copies; the initial state and reset() did not.
    it('does not alias the shared DEFAULT_INITIAL_CARDS object', () => {
      expect(useGameStore.getState().initialCards).toEqual(DEFAULT_INITIAL_CARDS);
      expect(useGameStore.getState().initialCards).not.toBe(DEFAULT_INITIAL_CARDS);
    });

    it('gives each reset its own copy', () => {
      const before = useGameStore.getState().initialCards;
      useGameStore.getState().reset();
      const after = useGameStore.getState().initialCards;

      expect(after).toEqual(DEFAULT_INITIAL_CARDS);
      expect(after).not.toBe(DEFAULT_INITIAL_CARDS);
      expect(after).not.toBe(before);
    });

    // Same hazard, the four collections initialCards was fixed alongside. They
    // are array literals built once at module load and spread into every reset,
    // so all resets share them. Immer's copy-on-write hides it today; a single
    // push outside a producer would corrupt the defaults for the session.
    it('gives each reset its own collections, not the module-level literals', () => {
      useGameStore.getState().reset();
      const first = useGameStore.getState();
      const before = {
        chartValues: first.chartValues,
        chartNames: first.chartNames,
        chartLabels: first.chartLabels,
        historyLog: first.historyLog,
      };

      useGameStore.getState().reset();
      const after = useGameStore.getState();

      expect(after.chartValues).not.toBe(before.chartValues);
      expect(after.chartNames).not.toBe(before.chartNames);
      expect(after.chartLabels).not.toBe(before.chartLabels);
      expect(after.historyLog).not.toBe(before.historyLog);
      expect(after.chartValues).toEqual([]);
      expect(after.historyLog).toEqual([]);
    });
  });

  describe('_resetTimersForTests', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops a running local game timer so it no longer fires after reset', () => {
      useGameStore.setState({
        mode: 'local', currentPlayerIndex: 0, finished: false, gameStartTime: Date.now(),
      });
      useGameStore.getState().startLocalTimers();

      vi.advanceTimersByTime(1000);
      expect(useGameStore.getState().gameTimeInSeconds).toBeGreaterThan(0);

      _resetTimersForTests();
      const snapshot = useGameStore.getState().gameTimeInSeconds;

      // Without the reset, this tick would have updated gameTimeInSeconds again.
      vi.advanceTimersByTime(5000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(snapshot);
    });
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

  it('defaults diceMode to digital, and falls back to it when the stored value is invalid', () => {
    // A fresh store (no tutto_diceMode key at all) must default to digital.
    expect(useGameStore.getState().diceMode).toBe('digital');

    localStorage.setItem('tutto_diceMode', 'not-a-real-mode');
    useGameStore.getState().init('device-123');
    expect(useGameStore.getState().diceMode).toBe('digital');
  });

  it('does not let a corrupted local-game save clobber a store action', () => {
    // Object.assign'ing an unvalidated parsed save into state could overwrite
    // an action (e.g. startGame) with whatever value the save file held.
    localStorage.setItem('tutto_local_game', JSON.stringify({ round: 3, startGame: 'not a function anymore' }));
    useGameStore.getState().init('device-123');
    expect(useGameStore.getState().round).toBe(3);
    expect(typeof useGameStore.getState().startGame).toBe('function');
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

  it('startGame refuses to start an online game below the player minimum', () => {
    // The lobby enforces two players; the end screen's Play Again reaches
    // startGame directly, so the store must hold the same line after
    // opponents have left the finished room.
    useGameStore.setState({
      mode: 'online', isOnline: true, isHost: true, status: 'playing', finished: true,
      round: 7,
      players: [{ name: 'Alice', score: 10000, position: 1 }],
    });

    useGameStore.getState().startGame();

    // Refused: the finished game stays finished, nothing resets.
    expect(useGameStore.getState().finished).toBe(true);
    expect(useGameStore.getState().round).toBe(7);
  });

  it('resuming a mid-game local save also restarts the 1-second game clock', () => {
    // App routes a restored playing save straight into <Game/> — so
    // setMode('local'), the only other startLocalTimers caller besides
    // startGame, never runs on that path. Without init starting the interval
    // itself, the displayed clock stays frozen at the saved value and the
    // NEXT reload re-anchors from that stale number, silently discarding all
    // the time played since this one.
    vi.useFakeTimers();
    try {
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
        status: 'playing',
        currentPlayerIndex: 0,
        finished: false,
        round: 2,
        gameTimeInSeconds: 50,
      }));
      useGameStore.getState().init('device-xyz');

      vi.advanceTimersByTime(3000);
      expect(useGameStore.getState().gameTimeInSeconds).toBe(53);
    } finally {
      _resetTimersForTests();
      vi.useRealTimers();
    }
  });

  it('does not restore the saved local game over a join link, and leaves the save on disk', () => {
    // A join link switches the client to online play before init() ever runs:
    // <Home/> mounts on App's first render and its link effect flushes ahead
    // of App's own (child effects run first). Restoring the saved game on top
    // of that routes App straight into <Game/>, unmounting the lobby the
    // invitation was meant to fill in.
    const savedGame = JSON.stringify({
      players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
      status: 'playing', currentPlayerIndex: 0, finished: false, round: 2, gameTimeInSeconds: 50,
    });
    localStorage.setItem('tutto_local_game', savedGame);
    useGameStore.setState({ mode: 'online' });

    useGameStore.getState().init('device-xyz');

    const state = useGameStore.getState();
    expect(state.deviceId).toBe('device-xyz');
    expect(state.players).toEqual([]);
    expect(state.currentPlayerIndex).toBeNull();
    expect(state.round).toBe(1);
    // The game is postponed, not lost — setMode('local') restores it later.
    expect(localStorage.getItem('tutto_local_game')).toBe(savedGame);
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

  it('persists previousWasBust/previousHighestTurnScore so undo after a reload stays accurate', () => {
    // calculateUndo reads both fields to revert bust counters and restore the
    // player's highestTurnScore. previousCard IS persisted (so undo stays
    // available after a reload) — if these two are dropped from the save, a
    // post-reload undo resets highestTurnScore to 0 and never reverts busts.
    useGameStore.setState({
      mode: 'local', status: 'playing',
      players: [{ ...namedPlayers('Alice')[0], score: 500, busts: 1, highestTurnScore: 800 }],
      currentPlayerIndex: 0, previousCard: '200', previousScore: 0,
      previousWasBust: true, previousHighestTurnScore: 800,
    });

    const savedRaw = localStorage.getItem('tutto_local_game')!;
    const saved = JSON.parse(savedRaw);
    expect(saved.previousWasBust).toBe(true);
    expect(saved.previousHighestTurnScore).toBe(800);

    // Simulate the reload: fresh store state, then init() restores the save.
    // reset() itself re-triggers the persistence subscriber (a real reload
    // doesn't — the page is gone), so put the on-disk save back before init.
    useGameStore.getState().reset();
    localStorage.setItem('tutto_local_game', savedRaw);
    useGameStore.getState().init('device-123');

    expect(useGameStore.getState().previousWasBust).toBe(true);
    expect(useGameStore.getState().previousHighestTurnScore).toBe(800);
  });

  it('persists previousHighestFeuerwerkTurnScore/previousHighestX2TurnScore so undo after a reload stays accurate', () => {
    // Same hazard as the previousHighestTurnScore test above, but for the
    // Feuerwerk/x2 siblings: calculateUndo restores
    // highestFeuerwerkTurnScore/highestX2TurnScore from these two fields, so
    // dropping them from the save resets both to 0 on a post-reload undo.
    useGameStore.setState({
      mode: 'local', status: 'playing',
      players: [{ ...namedPlayers('Alice')[0], score: 500, highestFeuerwerkTurnScore: 900, highestX2TurnScore: 700 }],
      currentPlayerIndex: 0, previousCard: 'Feuerwerk', previousScore: 300,
      previousHighestFeuerwerkTurnScore: 600, previousHighestX2TurnScore: 700,
    });

    const savedRaw = localStorage.getItem('tutto_local_game')!;
    const saved = JSON.parse(savedRaw);
    expect(saved.previousHighestFeuerwerkTurnScore).toBe(600);
    expect(saved.previousHighestX2TurnScore).toBe(700);

    useGameStore.getState().reset();
    localStorage.setItem('tutto_local_game', savedRaw);
    useGameStore.getState().init('device-123');

    expect(useGameStore.getState().previousHighestFeuerwerkTurnScore).toBe(600);
    expect(useGameStore.getState().previousHighestX2TurnScore).toBe(700);
  });

  it('nextTurn propagates previousHighestFeuerwerkTurnScore/X2TurnScore so a subsequent undo restores them instead of zeroing them (regression for STORE-BUG-1)', () => {
    useGameStore.setState({
      mode: 'local', status: 'playing', finished: false,
      players: [
        { ...namedPlayers('Alice')[0], score: 500, highestFeuerwerkTurnScore: 900 },
        { ...namedPlayers('Bob')[0], score: 200 },
      ],
      currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['200'],
      initialCards: { '200': 5 }, round: 1,
    });

    // Alice takes a 300-point Feuerwerk turn — below her existing 900 record,
    // so highestFeuerwerkTurnScore must stay 900, and the store must remember
    // that prior 900 so undo can restore it correctly.
    useGameStore.getState().nextTurn(300, true);
    expect(useGameStore.getState().previousHighestFeuerwerkTurnScore).toBe(900);

    useGameStore.getState().undo();
    expect(useGameStore.getState().players[0].highestFeuerwerkTurnScore).toBe(900);
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

  it('updateConfig drops out-of-range/invalid values instead of applying them (STORE-SMELL-4)', () => {
    useGameStore.setState({ winningScore: 6000, turnDuration: 120 });

    // @ts-expect-error -- intentionally invalid input to verify the guard
    useGameStore.getState().updateConfig({ winningScore: NaN, turnDuration: -5 });

    const state = useGameStore.getState();
    expect(state.winningScore).toBe(6000);
    expect(state.turnDuration).toBe(120);
  });

  describe('configSlice remaining setters and resets', () => {
    it('setDiceMode updates state and persists to localStorage', () => {
      useGameStore.getState().setDiceMode('digital');
      expect(useGameStore.getState().diceMode).toBe('digital');
      expect(localStorage.getItem('tutto_diceMode')).toBe('digital');
    });

    it('a dice mode chosen while online survives the switch back to local', () => {
      // The local persistence subscriber is inert while online, so the saved
      // game keeps whatever mode it was written with. setMode('local') applies
      // that save and does not re-read tutto_diceMode, so carrying diceMode in
      // the save silently reverted the player's live choice.
      localStorage.setItem('tutto_local_game', JSON.stringify({ round: 2, diceMode: 'digital' }));
      useGameStore.setState({ mode: 'online', isOnline: true });

      useGameStore.getState().setDiceMode('physical');
      useGameStore.getState().setMode('local');

      expect(useGameStore.getState().diceMode).toBe('physical');
      expect(localStorage.getItem('tutto_diceMode')).toBe('physical');
    });

    it('setDiceMode does not touch enforcedDiceMode while offline or not enforcing', () => {
      useGameStore.getState().setDiceMode('digital');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();

      useGameStore.setState({ isOnline: true, isHost: true, enforcedDiceMode: null });
      useGameStore.getState().setDiceMode('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setDiceMode follows the host\'s new choice while enforcement is active', () => {
      // While the host is enforcing a mode, their own DiceModeSelector doubles
      // as "which mode to enforce" — the enforced value must track it live
      // instead of requiring the host to re-toggle the checkbox.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ isOnline: true, isHost: true, roomId: 'ROOM1', enforcedDiceMode: 'digital' });
      mockEmit.mockClear();

      useGameStore.getState().setDiceMode('physical');

      expect(useGameStore.getState().diceMode).toBe('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBe('physical');
      const call = mockEmit.mock.calls.find(c => c[0] === 'updateConfig');
      expect(call?.[1]).toMatchObject({ enforcedDiceMode: 'physical' });
    });

    it('setDiceMode does not follow for a non-host client even while enforcedDiceMode is set', () => {
      useGameStore.setState({ isOnline: true, isHost: false, enforcedDiceMode: 'digital' });
      useGameStore.getState().setDiceMode('physical');
      expect(useGameStore.getState().enforcedDiceMode).toBe('digital');
    });

    it('setEnforcedDiceMode toggles enforcement on and off', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ isOnline: true, isHost: true, roomId: 'ROOM1' });
      mockEmit.mockClear();

      useGameStore.getState().setEnforcedDiceMode('digital');
      expect(useGameStore.getState().enforcedDiceMode).toBe('digital');

      useGameStore.getState().setEnforcedDiceMode(null);
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setAudioEnabled updates state and persists to localStorage', () => {
      useGameStore.getState().setAudioEnabled(false);
      expect(useGameStore.getState().audioEnabled).toBe(false);
      expect(localStorage.getItem('tutto_audioEnabled')).toBe('false');
    });

    it('setHapticsEnabled updates state and persists to localStorage', () => {
      useGameStore.getState().setHapticsEnabled(false);
      expect(useGameStore.getState().hapticsEnabled).toBe(false);
      expect(localStorage.getItem('tutto_hapticsEnabled')).toBe('false');
    });

    it('setInitialCards updates the deck composition', () => {
      const newCards = { Stop: 20, Kniffel: 0 };
      useGameStore.getState().setInitialCards(newCards as never);
      expect(useGameStore.getState().initialCards).toEqual(newCards);
    });

    it('setReconnectTimeout updates the kick timer', () => {
      useGameStore.getState().setReconnectTimeout(45);
      expect(useGameStore.getState().reconnectTimeout).toBe(45);
    });

    it('resetGeneralSettings restores winningScore/randomOrder/turnDuration/reconnectTimeout to defaults', () => {
      useGameStore.setState({ winningScore: 9999, randomOrder: false, turnDuration: 30, reconnectTimeout: 10 });
      useGameStore.getState().resetGeneralSettings();

      const state = useGameStore.getState();
      expect(state.winningScore).toBe(6000);
      expect(state.randomOrder).toBe(true);
      expect(state.turnDuration).toBe(120);
      expect(state.reconnectTimeout).toBe(60);
    });

    it('resetInitialCards restores the default deck each time it is called', () => {
      useGameStore.setState({ initialCards: { Stop: 0 } as never });
      useGameStore.getState().resetInitialCards();
      expect(useGameStore.getState().initialCards.Stop).toBe(10);

      // A second reset from a different tampered state must still land on the
      // same defaults — proving each call spreads a fresh copy rather than
      // handing out (and risking corruption of) the shared default object.
      useGameStore.setState({ initialCards: { Stop: 77 } as never });
      useGameStore.getState().resetInitialCards();
      expect(useGameStore.getState().initialCards.Stop).toBe(10);
    });

    it('updateConfig emits updateConfig over the socket only when online AND host AND a roomId exists', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      mockEmit.mockClear();

      // Online but not host — must not emit.
      useGameStore.setState({ isOnline: true, isHost: false, roomId: 'ROOM1' });
      useGameStore.getState().setWinningScore(7000);
      expect(mockEmit).not.toHaveBeenCalledWith('updateConfig', expect.any(Object));

      // Host but not online (e.g. local mode) — must not emit.
      useGameStore.setState({ isOnline: false, isHost: true, roomId: 'ROOM1' });
      useGameStore.getState().setWinningScore(7100);
      expect(mockEmit).not.toHaveBeenCalledWith('updateConfig', expect.any(Object));

      // Online + host but no roomId — must not emit.
      useGameStore.setState({ isOnline: true, isHost: true, roomId: null });
      useGameStore.getState().setWinningScore(7200);
      expect(mockEmit).not.toHaveBeenCalledWith('updateConfig', expect.any(Object));

      // Online + host + roomId — must emit the full config snapshot.
      useGameStore.setState({
        isOnline: true, isHost: true, roomId: 'ROOM1',
        initialCards: { Stop: 5 } as never, randomOrder: false, turnDuration: 45, reconnectTimeout: 20,
      });
      useGameStore.getState().setWinningScore(7300);
      expect(mockEmit).toHaveBeenCalledWith('updateConfig', {
        roomId: 'ROOM1',
        winningScore: 7300,
        initialCards: { Stop: 5 },
        randomOrder: false,
        turnDuration: 45,
        reconnectTimeout: 20,
        enforcedDiceMode: null,
        ruleset: 'modernized',
      });

      disconnectSocket();
    });
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

  it('sendReaction emits over the socket when online with a room', () => {
    useGameStore.getState().connectSocket('http://localhost:3000');
    useGameStore.setState({ isOnline: true, roomId: 'ROOM1' });
    mockEmit.mockClear();

    useGameStore.getState().sendReaction('🔥');

    expect(mockEmit).toHaveBeenCalledWith('sendReaction', { emoji: '🔥' });
    disconnectSocket();
  });

  it('sendReaction does nothing for local (non-online) games', () => {
    useGameStore.getState().connectSocket('http://localhost:3000');
    useGameStore.setState({ isOnline: false });
    mockEmit.mockClear();

    useGameStore.getState().sendReaction('🔥');

    expect(mockEmit).not.toHaveBeenCalledWith('sendReaction', expect.anything());
    disconnectSocket();
  });

  it('removeReaction filters the reaction out of state', () => {
    useGameStore.setState({
      reactions: [
        { id: 1, emoji: '🔥', senderName: 'Alice' },
        { id: 2, emoji: '❤️', senderName: 'Bob' },
      ],
    });

    useGameStore.getState().removeReaction(1);

    expect(useGameStore.getState().reactions).toEqual([{ id: 2, emoji: '❤️', senderName: 'Bob' }]);
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

  it('deals the initial deck with the same MAX_CLUSTER constraint mid-game rebuilds use', () => {
    // The opening deal used to be a plain shuffle, so a game could start with a
    // 4+ run of one card that buildDeck forbids everywhere else. currentCard is
    // drawn from the deck's head, so it counts toward the leading run.
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({ initialCards: { Stop: 30, x2: 20 } });

    for (let attempt = 0; attempt < 10; attempt++) {
      useGameStore.getState().startGame();
      const state = useGameStore.getState();
      const fullDeck = [state.currentCard, ...state.cards];

      expect(fullDeck).toHaveLength(50);
      expect(fullDeck.filter(c => c === 'Stop')).toHaveLength(30);
      expect(fullDeck.filter(c => c === 'x2')).toHaveLength(20);

      let cluster = 1;
      for (let i = 1; i < fullDeck.length; i++) {
        cluster = fullDeck[i] === fullDeck[i - 1] ? cluster + 1 : 1;
        expect(cluster).toBeLessThanOrEqual(3);
      }
    }
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
      previousPlayerName: 'P1',
      players: [{ name: 'P1', score: 500 }, { name: 'P2', score: 0 }]
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    // It should revert back to P1
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.previousCard).toBeNull();
  });

  it('appends history log on nextTurn and pops on undo', () => {
    useGameStore.getState().addPlayer('P1');
    useGameStore.getState().addPlayer('P2');
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 0,
      round: 1,
      currentCard: '300',
      historyLog: []
    });

    useGameStore.getState().nextTurn(500, true);
    let state = useGameStore.getState();
    expect(state.historyLog.length).toBe(1);
    expect(state.historyLog[0].playerName).toBe('P1');
    expect(state.historyLog[0].type).toBe('success');
    expect(state.historyLog[0].score).toBe(500);

    // Let's set up undo-able turn state
    useGameStore.setState({
      previousCard: '300',
      previousScore: 500,
      previousLeaders: [],
      previousPlayerName: 'P1',
      currentPlayerIndex: 1,
      round: 1,
      players: [{ name: 'P1', score: 500 }, { name: 'P2', score: 0 }]
    });

    useGameStore.getState().undo();
    state = useGameStore.getState();
    expect(state.historyLog.length).toBe(0);
  });

  it('caps historyLog at MAX_HISTORY_LOG_SIZE', () => {
    const log = Array.from({ length: 50 }, (_, i) => ({
      id: `rnd-P1-${i}`,
      round: 1,
      playerName: 'P1',
      card: '300' as const,
      type: 'success' as const,
      score: 100,
    }));
    useGameStore.getState().addPlayer('P1');
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 0,
      round: 1,
      currentCard: '300',
      historyLog: log,
    });

    useGameStore.getState().nextTurn(100, true);
    const state = useGameStore.getState();
    expect(state.historyLog.length).toBe(50);
    // The oldest entry should have been shifted out
    expect(state.historyLog[0].id).toBe('rnd-P1-1');
    expect(state.historyLog[49].id).toBe('1-P1-1');
  });

  it('undo clears the current player\'s live dice snapshot and cache, not just the previous-turn bookkeeping', () => {
    // Undo can be triggered while the CURRENT player is mid-roll (digital dice).
    // Without clearing liveTurnState/the localStorage cache too, spectators keep
    // seeing that in-progress roll attributed to whoever undo reassigns the turn
    // to, and a stale snapshot could be resumed into their next turn.
    useGameStore.getState().addPlayer('P1');
    const liveSnapshot = { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(liveSnapshot));
    useGameStore.setState({
      status: 'playing',
      currentPlayerIndex: 1,
      previousCard: 'x2',
      previousScore: 0,
      previousLeaders: [],
      previousPlayerName: 'P1',
      players: [{ name: 'P1', score: 500 }, { name: 'P2', score: 0 }],
      liveTurnState: liveSnapshot,
    });

    useGameStore.getState().undo();

    const state = useGameStore.getState();
    expect(state.liveTurnState).toBeNull();
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
  });

  it('starting a new game clears BOTH cached turn entries, digital and physical', () => {
    // A Play-Again (or any new local game) resets round to 1 with the same
    // room and ruleset — a chain cached by the PREVIOUS game could otherwise
    // key-collide and resurrect its cards and typed total into the new one.
    // The digital cache has always been cleared here; the physical one must
    // ride along at every such lifecycle boundary.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({ turnScore: 250 }));
    localStorage.setItem('tutto_physical_turn_state', JSON.stringify({
      turnKey: 'local:1:0:300:classic',
      cards: [{ card: '300', completed: true }],
      plusMinusScores: [],
      awaitingChoice: false,
      scoreInput: '350',
    }));

    const store = useGameStore.getState();
    store.addPlayer('Alice');
    store.startGame();

    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(localStorage.getItem('tutto_physical_turn_state')).toBeNull();
  });

  describe('local game stats saving', () => {
    it('does NOT send any stats when a local game ends', () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

      const store = useGameStore.getState();
      store.addPlayer('Alice');
      store.startGame();

      // Pinned rather than left to startGame's shuffle: a special card is
      // worth its fixed value or nothing, so whether this turn reaches the
      // winning score at all would otherwise depend on which card came up.
      useGameStore.setState({ currentCard: '200' });
      useGameStore.getState().nextTurn(6000, true);

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

    it('includes players-per-game, rounds, and feuerwerk/x2 turn maxima in endGameStats and submitGlobalStats payloads', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [
          { name: 'Bob', score: 2000, times1000PointsDeducted: 0 },
          { name: 'Alice', score: 5500, times1000PointsDeducted: 0, highestFeuerwerkTurnScore: 300, highestX2TurnScore: 400 },
        ],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {}, round: 4,
      });

      mockEmit.mockClear();

      // Winning turn for the last player in the round doesn't advance the round further.
      useGameStore.getState().nextTurn(500, true);

      expect(mockEmit).toHaveBeenCalledWith('endGameStats', expect.objectContaining({
        deviceId: 'dev-alice',
        stats: expect.objectContaining({
          totalPlayersSum: 2,
          mostPlayersInGame: 2,
          totalRoundsSum: 4,
          longestGameRounds: 4,
          highestFeuerwerkTurnScore: 300,
          highestX2TurnScore: 400,
        }),
      }));

      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', expect.objectContaining({
        roomId: 'ROOM1',
        payload: expect.objectContaining({
          totalPlayersSum: 2,
          mostPlayersInGame: 2,
          totalRoundsSum: 4,
          longestGameRounds: 4,
        }),
      }));
    });

    it('emits pushState BEFORE the stats events on the winning turn, so the server sees finished=true first', () => {
      // The server refuses endGameStats/submitGlobalStats until it has seen
      // finished=true (socketHandlers.ts), and socket.io preserves
      // per-connection event order — so the winning client's own submission
      // only lands if its pushState goes out first.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ name: 'Bob', score: 2000, times1000PointsDeducted: 0 }, { name: 'Alice', score: 5500, times1000PointsDeducted: 0 }],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {},
      });

      mockEmit.mockClear();

      useGameStore.getState().nextTurn(500, true);

      const eventOrder = mockEmit.mock.calls.map(c => c[0]);
      const pushIdx = eventOrder.indexOf('pushState');
      const endStatsIdx = eventOrder.indexOf('endGameStats');
      const globalStatsIdx = eventOrder.indexOf('submitGlobalStats');
      expect(pushIdx).toBeGreaterThanOrEqual(0);
      expect(endStatsIdx).toBeGreaterThan(pushIdx);
      expect(globalStatsIdx).toBeGreaterThan(pushIdx);
    });

    it('does not double-submit stats when the server echoes the finished gameState back to the host', () => {
      // The host's own pushState() round-trips through the server and comes back
      // as a 'gameState' broadcast (the host isn't excluded from their own room's
      // broadcast). nextTurn() already sent stats locally when it flipped
      // `finished` to true — the echo must not trigger a second submission.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [{ name: 'Bob', score: 2000, times1000PointsDeducted: 0 }, { name: 'Alice', score: 5500, times1000PointsDeducted: 0 }],
        currentPlayerIndex: 1, status: 'playing', finished: false,
        winningScore: 6000, initialCards: {},
      });

      mockEmit.mockClear();

      // Host triggers the winning turn — flips `finished` locally and sends stats.
      useGameStore.getState().nextTurn(500, true);

      const endGameStatsCallsAfterNextTurn = mockEmit.mock.calls.filter(c => c[0] === 'endGameStats').length;
      const submitGlobalStatsCallsAfterNextTurn = mockEmit.mock.calls.filter(c => c[0] === 'submitGlobalStats').length;
      expect(endGameStatsCallsAfterNextTurn).toBe(1);
      expect(submitGlobalStatsCallsAfterNextTurn).toBe(1);

      // Now simulate the server echoing the same finished state back to the host.
      mockOnHandlers['gameState']({
        status: 'playing',
        finished: true,
        players: useGameStore.getState().players,
      });

      // Counts must be unchanged — the echo must not trigger a second submission.
      const endGameStatsCallsAfterEcho = mockEmit.mock.calls.filter(c => c[0] === 'endGameStats').length;
      const submitGlobalStatsCallsAfterEcho = mockEmit.mock.calls.filter(c => c[0] === 'submitGlobalStats').length;
      expect(endGameStatsCallsAfterEcho).toBe(1);
      expect(submitGlobalStatsCallsAfterEcho).toBe(1);
    });
  });

  describe('socket callbacks', () => {
    beforeEach(() => {
      useGameStore.getState().connectSocket('http://localhost:3000');
    });

    afterEach(() => {
      // Every test below drives socketSlice through the handler it registered
      // under these keys. Left standing between tests, one test's registration
      // would keep answering for the next — and a registration socketSlice
      // stopped making altogether would still appear to be there. Dropping the
      // socket too is what makes the beforeEach above register afresh (
      // connectSocket is a no-op while a socket already exists).
      mockOnHandlers = {};
      disconnectSocket();
    });

    it('gameAborted adds a toast', () => {
      expect(mockOnHandlers['gameAborted']).toBeTypeOf('function');
      mockOnHandlers['gameAborted']();

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message === 'game.aborted' || t.message.toLowerCase().includes('aborted'))).toBe(true);
    });

    it('playerReaction appends to reactions and self-prunes after the display window', () => {
      vi.useFakeTimers();
      try {
        expect(mockOnHandlers['playerReaction']).toBeTypeOf('function');
        mockOnHandlers['playerReaction']({ id: 1, emoji: '🔥', senderName: 'Alice', senderColor: '#ff0000' });
        expect(useGameStore.getState().reactions).toEqual([{ id: 1, emoji: '🔥', senderName: 'Alice', senderColor: '#ff0000' }]);

        vi.runAllTimers();
        expect(useGameStore.getState().reactions).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('hostId updates isHost and hostId state', () => {
      expect(mockOnHandlers['hostId']).toBeTypeOf('function');
      mockOnHandlers['hostId']('socket-123'); // matches mock socket id
      expect(useGameStore.getState().isHost).toBe(true);
      expect(useGameStore.getState().hostId).toBe('socket-123');

      mockOnHandlers['hostId']('other-socket');
      expect(useGameStore.getState().isHost).toBe(false);
      expect(useGameStore.getState().hostId).toBe('other-socket');
    });

    // The 'finished' edge is the only thing that submits global stats, and
    // only the host may. If the host's socket is already dead when the winning
    // push lands, nobody submits: every connected client sees the edge but is
    // not host, and the promotion that follows used to only flip a flag. The
    // game was then missing from global_statistics for good.
    it('submits the global stats a dead host never sent when promotion lands on a finished game', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: true,
        players: [{ name: 'Alice', score: 6000 }, { name: 'Bob', score: 2000 }],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123'); // this client's own socket id

      expect(useGameStore.getState().isHost).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith('submitGlobalStats', expect.objectContaining({
        roomId: 'ROOM1',
      }));
    });

    it('does not resubmit global stats when an already-host client is re-told it is host', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: true, hostId: 'socket-123', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: true,
        players: [{ name: 'Alice', score: 6000 }, { name: 'Bob', score: 2000 }],
      });
      mockEmit.mockClear();

      // emitRoomState broadcasts hostId alongside every gameState, so this
      // arrives repeatedly for the whole end screen.
      mockOnHandlers['hostId']('socket-123');

      expect(mockEmit).not.toHaveBeenCalledWith('submitGlobalStats', expect.anything());
    });

    it('does not submit global stats on promotion while the game is still running', () => {
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, hostId: 'departed-host', roomId: 'ROOM1', myName: 'Alice',
        deviceId: 'dev-alice', finished: false,
        players: [{ name: 'Alice', score: 100 }, { name: 'Bob', score: 200 }],
      });
      mockEmit.mockClear();

      mockOnHandlers['hostId']('socket-123');

      expect(useGameStore.getState().isHost).toBe(true);
      expect(mockEmit).not.toHaveBeenCalledWith('submitGlobalStats', expect.anything());
    });

    // The lobby's join button and the reconnect popup's "Yes, Reconnect" both
    // race joinRoom against JOIN_TIMEOUT_MS already. The automatic rejoin on
    // 'connect' did not — and it is the one path with no user watching a
    // button: safeOn (server/socketContext.ts) catches a throwing handler and
    // logs it, so the ack simply never fires while the socket stays healthy.
    // Nothing then retries, and the full-screen "attempting to reconnect"
    // modal was up for good.
    describe('the automatic rejoin on reconnect', () => {
      const stageSeatedReconnect = () => {
        useGameStore.getState().setMode('online');
        useGameStore.setState({
          roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
          showReconnectPopup: true,
        });
      };

      it('gives up and lowers the popup when the ack never comes', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockClear();

          mockOnHandlers['connect']();
          expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
            roomId: 'ROOM1', name: 'Alice',
          }), expect.any(Function));

          // Still waiting: the deadline has not passed, so the popup stays up
          // and nothing has been said to the player.
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1);
          expect(useGameStore.getState().showReconnectPopup).toBe(true);

          vi.advanceTimersByTime(1);
          expect(useGameStore.getState().showReconnectPopup).toBe(false);
          expect(useGameStore.getState().toasts.length).toBeGreaterThan(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not fire once the ack has arrived', () => {
        vi.useFakeTimers();
        try {
          stageSeatedReconnect();
          mockEmit.mockImplementation((event, _payload, ack) => {
            if (event === 'joinRoom') ack({ success: true, isHost: false, name: 'Alice' });
          });

          mockOnHandlers['connect']();
          expect(useGameStore.getState().isHost).toBe(false);

          // The popup is the gameState handler's to lower from here (it clears
          // it on the sync that follows a successful rejoin) — the watchdog
          // must not have armed a late toast behind it.
          const toastsAfterAck = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toastsAfterAck);
        } finally {
          mockEmit.mockReset();
          vi.useRealTimers();
        }
      });

      it('arms no watchdog when there is no seat to rejoin', () => {
        vi.useFakeTimers();
        try {
          useGameStore.getState().setMode('online');
          useGameStore.setState({ roomId: null, myName: null, showReconnectPopup: true });
          mockEmit.mockClear();

          mockOnHandlers['connect']();

          // Nothing to rejoin: the popup is stale and lowered immediately, and
          // no join was ever sent for a watchdog to be waiting on.
          expect(mockEmit).not.toHaveBeenCalledWith('joinRoom', expect.anything(), expect.anything());
          expect(useGameStore.getState().showReconnectPopup).toBe(false);
          const toasts = useGameStore.getState().toasts.length;
          vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
          expect(useGameStore.getState().toasts.length).toBe(toasts);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('playerDisconnected adds a toast with reconnectTimeout', () => {
      useGameStore.setState({ reconnectTimeout: 45 });
      expect(mockOnHandlers['playerDisconnected']).toBeTypeOf('function');
      mockOnHandlers['playerDisconnected']('Alice');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message.includes('Alice disconnected! They have 45 seconds to reconnect.'))).toBe(true);
    });

    it('playerDisconnected omits the reconnect deadline when the kick timer is disabled (reconnectTimeout 0)', () => {
      // reconnectTimeout: 0 means the server never auto-kicks a disconnected
      // player (see server/socketHandlers.ts) — a "N seconds to reconnect"
      // message would invent a deadline that doesn't exist.
      useGameStore.setState({ reconnectTimeout: 0 });
      expect(mockOnHandlers['playerDisconnected']).toBeTypeOf('function');
      mockOnHandlers['playerDisconnected']('Alice');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message === 'Alice disconnected!')).toBe(true);
      expect(toasts.some(t => t.message.includes('seconds to reconnect'))).toBe(false);
    });

    it('nameConflictWithDisconnected adds a warning toast', () => {
      expect(mockOnHandlers['nameConflictWithDisconnected']).toBeTypeOf('function');
      mockOnHandlers['nameConflictWithDisconnected']('Bob');

      const toasts = useGameStore.getState().toasts;
      expect(toasts.some(t => t.message.includes('Someone tried to join as "Bob", which belongs to a disconnected player'))).toBe(true);
    });

    it('connect event emits joinRoom if roomId and myName exist', () => {
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice' });
      localStorage.setItem('tutto_color', '#ff0000');
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
        roomId: 'ROOM1',
        name: 'Alice',
        deviceId: 'dev-alice',
        color: '#ff0000',
      }), expect.any(Function));
    });

    it('a failed auto-rejoin clears the reconnect popup and drops back to the join form', () => {
      // The seat being unrecoverable (room deleted, name reclaimed) is
      // permanent — without this the "attempting to reconnect" popup stayed up
      // forever because only a gameState event ever cleared it.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
        isHost: true, hostId: 'socket-123',
        status: 'playing', currentPlayerIndex: 0,
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
      });
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'GONE_ROOM', myName: 'Alice' }));
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: false, error: 'Username already exists in this room' });

      const s = useGameStore.getState();
      expect(s.showReconnectPopup).toBe(false);
      expect(s.roomId).toBeNull();
      expect(s.myName).toBeNull();
      expect(s.isHost).toBe(false);
      expect(s.hostId).toBeNull();
      expect(s.status).toBe('lobby');
      expect(s.players).toEqual([]);
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(s.toasts.some(t => t.message.includes('Username already exists'))).toBe(true);
    });

    it('translates a refusal the server named a code for, instead of toasting its English prose', () => {
      // The server sends prose AND a stable code (JOIN_REFUSAL_CODES); the
      // prose is English whatever the player's language is, so the code is
      // what the toast should actually be built from.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
        showReconnectPopup: true,
      });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: false, code: 'name_taken', error: 'Username already exists in this room' });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages).toContain('That name is already taken in this room.');
      expect(messages.some(m => m.includes('Username already exists'))).toBe(false);
    });

    it('falls back to the raw prose for a refusal carrying no code', () => {
      // An older server, or a refusal this client has no key for: the player
      // still learns why, just untranslated.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'GONE_ROOM', myName: 'Alice', deviceId: 'dev-alice',
      });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      joinRoomCall[2]({ success: false, error: 'Refused for a reason this client predates' });

      expect(useGameStore.getState().toasts.map(t => t.message))
        .toContain('Refused for a reason this client predates');
    });

    it('a successful auto-rejoin keeps the room state and only refreshes isHost', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', isHost: false,
        players: namedPlayers('Alice', 'Bob'),
      });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: true });

      const s = useGameStore.getState();
      expect(s.roomId).toBe('ROOM1');
      expect(s.myName).toBe('Alice');
      expect(s.isHost).toBe(true);
      expect(s.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
    });
  });

  describe('legacy config fallback', () => {
    it('setMode(local) parses and merges config from localStorage fallback', () => {
      const legacyState = { winningScore: 7000, randomOrder: false, turnDuration: 300, reconnectTimeout: 120, initialCards: { '200': 10 } };
      localStorage.setItem('tutto_local_game', JSON.stringify(legacyState));

      useGameStore.getState().setMode('local');
      const state = useGameStore.getState();

      expect(state.winningScore).toBe(7000);
      expect(state.randomOrder).toBe(false);
      expect(state.turnDuration).toBe(300);
      expect(state.reconnectTimeout).toBe(120);
      expect(state.initialCards['200']).toBe(10);
    });
  });

  describe('enforcedDiceMode mode-switch resets', () => {
    it('setMode(local) resets a leftover enforcedDiceMode from a previous online room', () => {
      useGameStore.setState({ enforcedDiceMode: 'digital' });
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setMode(online) does not carry a stale enforcedDiceMode into a fresh room join', () => {
      useGameStore.setState({ enforcedDiceMode: 'digital' });
      localStorage.removeItem('tutto_online_config');
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().enforcedDiceMode).toBeNull();
    });

    it('setMode(online) restores a saved enforcedDiceMode from a previous hosted room', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 6000, randomOrder: true, turnDuration: 120, reconnectTimeout: 60,
        initialCards: { '200': 10 }, enforcedDiceMode: 'physical',
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().enforcedDiceMode).toBe('physical');
      localStorage.removeItem('tutto_online_config');
    });
  });

  describe('ruleset mode-switch resets', () => {
    it('setMode(local) with no local save resets a leftover online ruleset', () => {
      // Staged from ONLINE mode: in local mode the persistence subscriber
      // would immediately save the staged ruleset as a local game, and the
      // switch would (correctly) restore it instead of resetting.
      localStorage.removeItem('tutto_online_config');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ ruleset: 'classic' });
      localStorage.removeItem('tutto_local_game');
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().ruleset).toBe('modernized');
    });

    it('setMode(local) restores the ruleset a saved local game was played by', () => {
      // Unlike enforcedDiceMode, the ruleset IS part of a local save — it
      // decides how the resumed game actually plays.
      localStorage.setItem('tutto_local_game', JSON.stringify({ ruleset: 'classic', round: 2 }));
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().ruleset).toBe('classic');
      localStorage.removeItem('tutto_local_game');
    });

    it('setMode(online) restores a saved ruleset from a previous hosted room', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({ ruleset: 'classic' }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().ruleset).toBe('classic');
      localStorage.removeItem('tutto_online_config');
    });

    it('setMode(online) with no saved config falls back to modernized', () => {
      localStorage.removeItem('tutto_online_config');
      useGameStore.setState({ ruleset: 'classic' });
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().ruleset).toBe('modernized');
    });
  });

  describe('socket disconnect behavior', () => {
    it('sets showReconnectPopup when disconnected unexpectedly while seated in a room', () => {
      // Connect to online mode
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alice' });

      // Ensure the 'disconnect' handler was registered
      expect(mockOnHandlers['disconnect']).toBeDefined();

      // Trigger unexpected disconnect
      mockOnHandlers['disconnect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('does NOT set showReconnectPopup when online without a seat to reclaim', () => {
      // Sitting on the online join form (left the room / finished the game):
      // there is nothing to reconnect TO, so the full-screen "attempting to
      // reconnect" modal reports a loss the player cannot act on.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: null, myName: null });

      expect(mockOnHandlers['disconnect']).toBeTypeOf('function');
      mockOnHandlers['disconnect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
    });

    it('lowers a raised reconnect popup on connect when there is nothing to rejoin', () => {
      // The other half of the same bug: without this, a popup raised while
      // seatless stayed up after the connection came back, because the
      // 'connect' handler only ever acted when a seat was worth reclaiming.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: null, myName: null, showReconnectPopup: true });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(false);
      expect(mockEmit).not.toHaveBeenCalledWith('joinRoom', expect.anything(), expect.anything());
    });

    it('leaves the popup up on connect while a session restore is still in flight', () => {
      // The restore prompt raises the popup itself and only then calls
      // joinRoom — the store holds no roomId (and is still in local mode)
      // until the server acks, so the reconnect that carries that very join
      // must not pull the modal out from under it.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ mode: 'local', roomId: null, myName: null, showReconnectPopup: true });

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(useGameStore.getState().showReconnectPopup).toBe(true);
    });

    it('still attempts the auto-rejoin, popup and all, when a seat is held', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice', showReconnectPopup: true,
      });
      mockEmit.mockClear();

      expect(mockOnHandlers['connect']).toBeTypeOf('function');
      mockOnHandlers['connect']();

      expect(mockEmit).toHaveBeenCalledWith('joinRoom', expect.objectContaining({
        roomId: 'ROOM1', name: 'Alice', deviceId: 'dev-alice',
      }), expect.any(Function));
      // Still "attempting to reconnect" until the ack decides the seat's fate.
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
      // Asserted, not guarded: a missing handler would make the expectation
      // below pass without anything having happened.
      expect(mockOnHandlers['disconnect']).toBeTypeOf('function');
      mockOnHandlers['disconnect']();

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

    it('clears session/room state, toasts, and returns to local mode when kicked from a room', () => {
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'TEST_ROOM', myName: 'Alice' }));

      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'TEST_ROOM', isHost: true, hostId: 'socket-123', myName: 'Alice',
        // The room's in-progress game — without clearing these too, a kicked
        // player with no saved local game (setMode('local') only overwrites
        // keys a save happens to contain) would land on the local lobby still
        // showing the online roster and mid-game state (bug: kicked bleed).
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Stop', round: 3,
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });

      expect(mockOnHandlers['kicked']).toBeTypeOf('function');
      mockOnHandlers['kicked']();

      const state = useGameStore.getState();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(state.roomId).toBeNull();
      expect(state.isHost).toBe(false);
      expect(state.hostId).toBeNull();
      expect(state.myName).toBeNull();
      expect(state.mode).toBe('local');
      expect(state.isOnline).toBe(false);
      expect(state.toasts.map(t => t.message)).toContain('You were kicked by the host');
      expect(state.players).toEqual([]);
      expect(state.status).toBe('lobby');
      expect(state.currentPlayerIndex).toBeNull();
      expect(state.currentCard).toBeNull();
      expect(state.round).toBe(1);
      expect(state.finished).toBe(false);
      expect(state.liveTurnState).toBeNull();
    });

    it('surrenders the seat the same way when the same device takes it over elsewhere', () => {
      // The server moves the seat to the new connection and drops this one
      // from the channel. Silently, that left this window holding a full
      // roster on a healthy socket whose every event the server ignores — the
      // player could open the dice panel and commit turns into a void while
      // the turn timer ran out on the seat they thought they had.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        roomId: 'TEST_ROOM', isHost: true, hostId: 'socket-123', myName: 'Alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        status: 'playing', currentPlayerIndex: 0, round: 3,
      });

      expect(mockOnHandlers['seatTakenOver']).toBeTypeOf('function');
      mockOnHandlers['seatTakenOver']();

      const state = useGameStore.getState();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(state.roomId).toBeNull();
      expect(state.myName).toBeNull();
      expect(state.isHost).toBe(false);
      expect(state.mode).toBe('local');
      expect(state.players).toEqual([]);
      expect(state.status).toBe('lobby');
      // Its own wording — nobody kicked them.
      expect(state.toasts.map(t => t.message))
        .toEqual(['This device joined the room from somewhere else, so this window left it.']);
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
        roomId: 'R1',
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
        roomId: 'R1',
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
        mode: 'online', isOnline: true, roomId: 'R1', status: 'playing',
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

    it('justReconnected flag persists across a syncOnlineTimers call — only the gameState handler clears it', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
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

      // syncOnlineTimers must NOT clear justReconnected — it's consulted (not
      // reset) there to decide whether to reuse the server's turnTimeRemaining.
      expect(useGameStore.getState().justReconnected).toBe(true);
    });

    it('the gameState handler self-clears justReconnected on the next event that is not itself a reconnect', () => {
      useGameStore.setState({
        mode: 'online',
        isOnline: true,
        roomId: 'R1',
        showReconnectPopup: true,
        status: 'playing',
        currentPlayerIndex: 0,
      });

      // First event: a genuine reconnect — sets the flag.
      mockOnHandlers['gameState']({
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: null,
      });
      expect(useGameStore.getState().justReconnected).toBe(true);

      // Second event: an ordinary update, not a fresh reconnect (showReconnectPopup
      // is already false by now) — must clear the flag rather than leaving it
      // stuck true for a future, unrelated turn to pick up.
      mockOnHandlers['gameState']({
        status: 'playing',
        currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Alice')],
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [] },
      });
      expect(useGameStore.getState().justReconnected).toBe(false);
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

    it('adopts the server turnTimeRemaining on reconnect even when the turn tracking is fresh (page reload)', () => {
      // After a page reload the module-level turn tracking vars are empty (the
      // beforeEach _resetTimersForTests() mirrors that), so playerChanged is
      // true. The gameState answering the rejoin carries the server's actual
      // remaining time — that value must win over the "new turn → full
      // duration" heuristic, or the countdown shows a full turn mid-turn.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', showReconnectPopup: true,
        status: 'playing', turnDuration: 60,
      });

      mockOnHandlers['gameState']({
        status: 'playing', currentPlayerIndex: 1, currentCard: 'Kniffel',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        turnDuration: 60, turnTimeRemaining: 25, gameTimeInSeconds: 30,
      });

      expect(useGameStore.getState().justReconnected).toBe(true);
      expect(useGameStore.getState().turnTimeRemaining).toBe(25);

      // Later tests expect no lingering module-level socket (e.g. they assert
      // that joinRoom creates a fresh one).
      disconnectSocket();
    });

    it('restarts the countdown from the server turnTimeRemaining even after the local countdown hit 0', () => {
      vi.useFakeTimers();
      try {
        useGameStore.getState().connectSocket('http://localhost:3000');
        useGameStore.setState({
          mode: 'online', isOnline: true, roomId: 'R1', status: 'playing',
          currentPlayerIndex: 0, currentCard: 'Kniffel', turnDuration: 60,
          showReconnectPopup: false, justReconnected: false,
        });
        useGameStore.getState().syncOnlineTimers(); // prime: full 60s countdown
        vi.advanceTimersByTime(61_000); // countdown reaches 0 and its interval self-clears
        expect(useGameStore.getState().turnTimeRemaining).toBe(0);

        // A mid-turn broadcast for the SAME player/card carrying the
        // authoritative remaining time (e.g. the host raised turnDuration
        // mid-turn): the display must resume counting from the server value
        // instead of staying frozen at 0 with its interval gone.
        mockOnHandlers['gameState']({
          status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel',
          players: [makeOnlinePlayer('Alice')],
          turnDuration: 60, turnTimeRemaining: 30, gameTimeInSeconds: 43,
        });
        expect(useGameStore.getState().turnTimeRemaining).toBe(30);

        vi.advanceTimersByTime(1000);
        expect(useGameStore.getState().turnTimeRemaining).toBe(29);
      } finally {
        disconnectSocket();
        vi.useRealTimers();
      }
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

    it('local timer increments between server syncs', () => {
      // Fake timers instead of a real 1100ms wait: under a loaded test run, a
      // real setInterval(..., 1000) can fire late enough that a 1100ms wait
      // observes zero ticks, making this test flaky (it failed intermittently
      // in the full suite while passing in isolation).
      vi.useFakeTimers();
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

      vi.advanceTimersByTime(1100);

      // Timer should have incremented by ~1
      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initialTime + 1);
      vi.useRealTimers();
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

    it('game time does not drift on repeated syncs', () => {
      vi.useFakeTimers();
      try {
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

          // Fast-forward simulated time between syncs
          if (i < 2) vi.advanceTimersByTime(1100);
        }

        // Verify no large drifts between server and local times
        syncTimes.forEach(({ server, local }) => {
          expect(Math.abs(server - local)).toBeLessThanOrEqual(1);
        });
      } finally {
        _resetTimersForTests();
        vi.useRealTimers();
      }
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

    it('game timer increments correctly via gameStartTime reference', () => {
      vi.useFakeTimers();
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

      vi.advanceTimersByTime(1100);

      const afterWait = useGameStore.getState().gameTimeInSeconds;
      expect(afterWait).toBeGreaterThanOrEqual(initial! + 1);
      vi.useRealTimers();
    });

    it('game timer does not tick when gameStartTime is null (null gameTimeInSeconds skips anchor)', () => {
      vi.useFakeTimers();
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

      vi.advanceTimersByTime(1100);

      // Without gameStartTime the timer interval has nothing to compute — value stays null.
      expect(useGameStore.getState().gameTimeInSeconds).toBeNull();
      vi.useRealTimers();
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

    it('cancelReconnect clears the abandoned room identity and game state ("Return to Main Menu")', () => {
      // Without this, the stale roomId later rendered a phantom joined-room
      // lobby, and the online roster could bleed into local mode — the
      // setMode('local') that follows only overwrites keys a saved local game
      // happens to contain.
      useGameStore.setState({
        mode: 'online', isOnline: true,
        roomId: 'R1', myName: 'Alice', isHost: true, hostId: 'socket-123',
        status: 'playing', currentPlayerIndex: 1, currentCard: 'Stop',
        cards: ['x2'], round: 4, finished: false,
        players: namedPlayers('Alice', 'Bob'),
        showReconnectPopup: true,
      });

      useGameStore.getState().cancelReconnect();

      const s = useGameStore.getState();
      expect(s.roomId).toBeNull();
      expect(s.myName).toBeNull();
      expect(s.isHost).toBe(false);
      expect(s.hostId).toBeNull();
      expect(s.players).toEqual([]);
      expect(s.status).toBe('lobby');
      expect(s.currentPlayerIndex).toBeNull();
      expect(s.currentCard).toBeNull();
      expect(s.cards).toEqual([]);
      expect(s.round).toBe(1);
    });

    it('cancelReconnect(roomId, name) without an active store room leaves a restored local game untouched', () => {
      // Declining the restore prompt happens on a fresh page load where the
      // store may already hold a restored LOCAL game. Only the roomId ARGUMENT
      // (the room to leave server-side) is set there — the store's own roomId
      // is null, and nothing in the store may be wiped.
      useGameStore.setState({
        mode: 'local', isOnline: false, roomId: null,
        status: 'playing', currentPlayerIndex: 0, round: 3,
        players: namedPlayers('Carol', 'Dave'),
        pendingReconnectSession: { roomId: 'OLD_ROOM', myName: 'Carol' },
      });

      useGameStore.getState().cancelReconnect('OLD_ROOM', 'Carol');

      const s = useGameStore.getState();
      expect(s.players.map(p => p.name)).toEqual(['Carol', 'Dave']);
      expect(s.status).toBe('playing');
      expect(s.round).toBe(3);
      expect(s.currentPlayerIndex).toBe(0);
    });

    it('joinRoom extracts and emits initialConfig from localStorage', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000,
        randomOrder: false,
        turnDuration: 30,
        reconnectTimeout: 10,
        initialCards: { '200': 10 }
      }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM', 'Alice', false);
      expect(io).toHaveBeenCalledWith(expect.any(String));
      mockOnHandlers['connect']();

      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      expect(joinRoomCall[1]).toMatchObject({
        roomId: 'CONFIG_ROOM',
        name: 'Alice',
        initialConfig: {
          winningScore: 8000,
          randomOrder: false,
          turnDuration: 30,
          reconnectTimeout: 10,
          initialCards: { '200': 10 }
        }
      });

      const joinCallback = joinRoomCall[2];
      joinCallback({ success: true, isHost: true });
      await joinPromise;

      const state = useGameStore.getState();
      expect(state.roomId).toBe('CONFIG_ROOM');
      
      // Should show the translated "Saved settings loaded" toast instead of individual ones
      const toasts = state.toasts;
      expect(toasts.some(t => t.message === 'lobby.savedSettingsLoaded' || t.message === 'Saved settings loaded')).toBe(true);
      expect(toasts.some(t => t.message.includes('Winning score'))).toBe(false);

      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom includes a saved enforcedDiceMode in the transmitted initialConfig', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000, randomOrder: false, turnDuration: 30, reconnectTimeout: 10,
        initialCards: { '200': 10 }, enforcedDiceMode: 'digital',
      }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM2', 'Alice', false);
      mockOnHandlers['connect']();

      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall[1].initialConfig).toMatchObject({ enforcedDiceMode: 'digital' });

      joinRoomCall[2]({ success: true, isHost: true });
      await joinPromise;
      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom includes a saved ruleset in the transmitted initialConfig', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockEmit.mockClear();

      localStorage.setItem('tutto_online_config', JSON.stringify({ ruleset: 'classic' }));

      const joinPromise = useGameStore.getState().joinRoom('CONFIG_ROOM3', 'Alice', false);
      mockOnHandlers['connect']();

      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall[1].initialConfig).toMatchObject({ ruleset: 'classic' });

      joinRoomCall[2]({ success: true, isHost: true });
      await joinPromise;
      localStorage.removeItem('tutto_online_config');
    });

    it('joinRoom adopts the server-confirmed name from the ack (mid-game seat takeover)', async () => {
      // Rejoining a running game with a different name keeps the seat's
      // original name server-side; the client must adopt it or isMyTurn and
      // stats matching (both keyed on myName) silently break.
      mockEmit.mockClear();

      const joinPromise = useGameStore.getState().joinRoom('SEAT_ROOM', 'Impostor', true);
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: false, name: 'Alice' });
      await joinPromise;

      expect(useGameStore.getState().myName).toBe('Alice');
      expect(JSON.parse(sessionStorage.getItem('tutto_online_session'))).toEqual({ roomId: 'SEAT_ROOM', myName: 'Alice' });
    });

    it('auto-rejoin adopts the server-confirmed name when provided', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({ roomId: 'ROOM1', myName: 'Alicia', deviceId: 'dev-a', mode: 'online', isOnline: true });
      mockEmit.mockClear();

      mockOnHandlers['connect']();
      const joinRoomCall = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(joinRoomCall).toBeTruthy();
      joinRoomCall[2]({ success: true, isHost: false, name: 'Alice' });

      expect(useGameStore.getState().myName).toBe('Alice');
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

    it('cancelReconnect called multiple times disconnects the prior temp socket instead of leaving it dangling (STORE-SMELL-7)', async () => {
      const { io } = await import('socket.io-client');
      io.mockClear();
      mockDisconnect.mockClear();

      const store = useGameStore.getState();

      // First call with roomId - creates a temp socket, not yet disconnected.
      store.cancelReconnect('ROOM_1', 'Alice');
      expect(io).toHaveBeenCalledTimes(1);
      // Clears any disconnect triggered by this call cleaning up a dangling
      // attempt left pending by an earlier test — isolates this test to just
      // what happens from here on.
      mockDisconnect.mockClear();

      // Second call with roomId - the first attempt is cancelled (disconnected)
      // before a second temp socket is created.
      store.cancelReconnect('ROOM_2', 'Bob');
      expect(io).toHaveBeenCalledTimes(2);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Call without roomId - does NOT create a temp socket, but does clean up
      // the still-pending second attempt.
      store.cancelReconnect();
      expect(io).toHaveBeenCalledTimes(2);
      expect(mockDisconnect).toHaveBeenCalledTimes(2);

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

  describe('addPlayer store-level invariants', () => {
    it('ignores a name differing only by case from an existing player', () => {
      // Duplicate names break every name-keyed lookup (Plus/Minus deduction,
      // undo, pushState merging) and make persistence.hasUniquePlayerNames
      // drop the entire restored save on the next reload — the store must
      // enforce this itself, not rely on LocalLobby being the only caller.
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('alice');

      expect(useGameStore.getState().players.map(p => p.name)).toEqual(['Alice']);
    });

    it('ignores empty, whitespace-only, and over-length names', () => {
      useGameStore.getState().addPlayer('');
      useGameStore.getState().addPlayer('   ');
      useGameStore.getState().addPlayer('x'.repeat(31));

      expect(useGameStore.getState().players).toEqual([]);
    });

    it('trims surrounding whitespace, matching the lobby input', () => {
      useGameStore.getState().addPlayer('  Alice  ');

      expect(useGameStore.getState().players.map(p => p.name)).toEqual(['Alice']);
    });
  });

  describe('player identity (Player.id)', () => {
    it('mints a non-empty, unique id for each new player', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      const [alice, bob] = useGameStore.getState().players;

      expect(alice.id).toBeTruthy();
      expect(bob.id).toBeTruthy();
      expect(alice.id).not.toBe(bob.id);
    });

    it('preserves each player’s id across the startGame stat reset', () => {
      // randomOrder is on by default — startGame legitimately reshuffles the
      // roster, so this compares the SET of ids (not array order) before and
      // after, to isolate "did startGame mint fresh ids" from "did it shuffle".
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      const idsBefore = new Set(useGameStore.getState().players.map(p => p.id));

      useGameStore.getState().startGame();

      const idsAfter = new Set(useGameStore.getState().players.map(p => p.id));
      expect(idsAfter).toEqual(idsBefore);
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

  describe('gameState after leaving online mode', () => {
    it('ignores a broadcast that lands once the client is back in local mode', () => {
      // leaveRoom/kicked flip the mode before the socket fully tears down —
      // a late broadcast applied then would inject the online room into
      // local state, and the local persistence subscriber would immediately
      // write it to disk.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.getState().setMode('local');
      useGameStore.setState({ players: [], status: 'lobby', round: 1 });

      mockOnHandlers['gameState']({
        status: 'playing', round: 5, currentPlayerIndex: 0,
        players: [makeOnlinePlayer('Stranger')],
      });

      const state = useGameStore.getState();
      expect(state.status).toBe('lobby');
      expect(state.round).toBe(1);
      expect(state.players).toEqual([]);
    });

    it('ignores a broadcast for the room it just left, while still in online mode', () => {
      // The mode check above cannot see this one. leaveRoom applies
      // clearRoomState, which contains neither `mode` nor `isOnline` — four of
      // its five call sites deliberately stay in online mode so the user lands
      // back on the join form. The server only drops the socket from the
      // channel when it processes the leave, so anything emitted during that
      // round trip still arrives, and it restored players/finished/
      // currentPlayerIndex — which is exactly what App.tsx routes off. The
      // result was Game/EndScreen rendered over a roomId-less store where
      // every action silently no-ops and the turn countdown restarts.
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', myName: 'Alice',
        status: 'playing', players: namedPlayers('Alice', 'Bob'), round: 3,
      });

      useGameStore.getState().leaveRoom();
      expect(useGameStore.getState().mode, 'the user stays on the online join form').toBe('online');

      mockOnHandlers['gameState']({
        status: 'playing', round: 5, currentPlayerIndex: 0, finished: true,
        players: [makeOnlinePlayer('Stranger')],
      });

      const state = useGameStore.getState();
      expect(state.roomId).toBeNull();
      expect(state.players).toEqual([]);
      expect(state.finished).toBe(false);
      expect(state.currentPlayerIndex).toBeNull();
      expect(state.status).toBe('lobby');
    });
  });

  // clearRoomState's contract: once a room is abandoned, nothing of that game
  // may survive into local mode. It used to clear only the roster and the room
  // identity, so the chart series, the activity log and the previous-turn undo
  // block rode along — and since setMode('local') only overwrites what a saved
  // local game happens to contain, they could then be persisted into
  // `tutto_local_game` and shown inside an unrelated local game.
  describe('abandoning an online room clears the whole game, not just the roster', () => {
    const seatOnlineGame = () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        mode: 'online', isOnline: true, roomId: 'R1', myName: 'Alice',
        players: namedPlayers('Alice', 'Bob'),
        status: 'playing', round: 3, currentPlayerIndex: 1, finished: false,
        turnDuration: 60, turnTimeRemaining: 47,
        chartValues: [[100], [200]], chartNames: ['Alice', 'Bob'], chartLabels: [1],
        historyLog: [{ id: 'h1', round: 1, playerName: 'Alice', card: '200', type: 'success', score: 100 }],
        previousCard: '200', previousScore: 100, previousPlayerName: 'Alice',
        previousWasBust: false, previousWasSuccess: true, previousHighestTurnScore: 100,
      });
    };

    const expectNothingLeftOver = () => {
      const s = useGameStore.getState();
      expect(s.players).toEqual([]);
      // Scoreboard renders its turn-timer tile whenever this is non-null, and
      // a local game has no turn timer at all — so an abandoned room's
      // countdown would sit frozen in one.
      expect(s.turnTimeRemaining).toBeNull();
      expect(s.chartValues).toEqual([]);
      expect(s.chartNames).toEqual([]);
      expect(s.chartLabels).toEqual([]);
      expect(s.historyLog).toEqual([]);
      expect(s.previousCard).toBeNull();
      expect(s.previousScore).toBeNull();
      expect(s.previousPlayerName).toBeNull();
      expect(s.previousTurnSummary).toBeNull();
      expect(s.previousHighestTurnScore).toBe(0);
      // undefined, not false — "no outcome recorded" (see noUndoableTurn).
      expect(s.previousWasSuccess).toBeUndefined();
    };

    it('leaveRoom drops the chart series, the activity log and the undo block', () => {
      seatOnlineGame();
      useGameStore.getState().leaveRoom();
      expectNothingLeftOver();
    });

    it('a kick drops them too', () => {
      seatOnlineGame();
      mockOnHandlers['kicked']();
      expectNothingLeftOver();
    });

    it('cancelReconnect drops them once a room was actually joined', () => {
      seatOnlineGame();
      useGameStore.getState().cancelReconnect();
      expectNothingLeftOver();
    });

    it('leaves no live Undo button behind in local mode', () => {
      // With no saved local game there is nothing to overwrite the leftovers,
      // so Game.tsx's hasUndoableTurn used to offer Undo for a turn played in
      // a room this client already left.
      seatOnlineGame();
      useGameStore.getState().leaveRoom();
      localStorage.removeItem('tutto_local_game');
      useGameStore.getState().setMode('local');
      expect(useGameStore.getState().previousCard).toBeNull();
      expect(useGameStore.getState().previousPlayerName).toBeNull();
    });
  });

  // chartValues is player-indexed — one score series per player. Both
  // server-side twins (turnTimers.advanceTurnOnTimeout,
  // rooms.handleActivePlayerRemoved) refuse to append when the two disagree;
  // the client indexed result.players past the end and threw, taking the game
  // into the ErrorBoundary's clear-and-reload.
  describe('round-end chart bookkeeping', () => {
    const stagePlayingRound = (chartValues) => {
      useGameStore.setState({
        mode: 'local', isOnline: false, status: 'playing',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 1, // committing this turn wraps the round
        currentCard: '200', cards: ['300'], round: 2,
        chartValues, chartLabels: [1],
      });
    };

    it('appends a datapoint per player when the series match the roster', () => {
      stagePlayingRound([[100], [200]]);
      useGameStore.getState().nextTurn(100, true);
      expect(useGameStore.getState().chartValues).toEqual([[100, 0], [200, 100]]);
      expect(useGameStore.getState().chartLabels).toEqual([1, 2]);
    });

    it('skips the append instead of crashing when there are more series than players', () => {
      stagePlayingRound([[100], [200], [300]]);
      expect(() => useGameStore.getState().nextTurn(100, true)).not.toThrow();
      expect(useGameStore.getState().chartValues).toEqual([[100], [200], [300]]);
      // The label may only be appended when the series it labels were.
      expect(useGameStore.getState().chartLabels).toEqual([1]);
    });

    it('skips it for fewer series than players too, rather than charting a partial round', () => {
      stagePlayingRound([[100]]);
      expect(() => useGameStore.getState().nextTurn(100, true)).not.toThrow();
      expect(useGameStore.getState().chartValues).toEqual([[100]]);
      expect(useGameStore.getState().chartLabels).toEqual([1]);
    });
  });

  describe('online config-change toasts', () => {
    beforeEach(() => {
      // These tests simulate an already-joined lobby receiving a LATER host
      // change — the first-sync suppression (roomStateSynced) must be armed
      // past its quiet first gameState.
      useGameStore.setState({ roomStateSynced: true });
    });

    it('stays quiet on the first gameState after joining — the room introducing itself is not a change', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // This device once hosted with a custom config; the joined room runs
      // defaults. The differences are the ROOM'S existing settings, not
      // changes anybody made.
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 10000, ruleset: 'classic', toasts: [], roomStateSynced: false });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 6000, ruleset: 'modernized', players: [] });

      expect(useGameStore.getState().toasts).toEqual([]);
      // The sync itself still applies…
      expect(useGameStore.getState().winningScore).toBe(6000);

      // …and a LATER host change toasts as before.
      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 8000, players: [] });
      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('8000'))).toBe(true);
    });

    it('joinRoom re-arms the first-sync suppression for the next room', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomStateSynced: true });

      void useGameStore.getState().joinRoom('ROOM2', 'Alice');

      expect(useGameStore.getState().roomStateSynced).toBe(false);
    });

    it('toasts when the host changes the winning score in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', winningScore: 6000 });

      mockOnHandlers['gameState']({ status: 'lobby', winningScore: 8000, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('8000'))).toBe(true);
    });

    it('toasts when the host turns on dice mode enforcement in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: null });

      mockOnHandlers['gameState']({ status: 'lobby', enforcedDiceMode: 'digital', players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Digital Dice'))).toBe(true);
    });

    it('toasts when the host turns off dice mode enforcement in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: 'physical' });

      mockOnHandlers['gameState']({ status: 'lobby', enforcedDiceMode: null, players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Disabled'))).toBe(true);
    });

    it('does not toast config changes for a partial gameState payload that omits those keys', () => {
      // The sync loop guards every field with `key in serverState`; the toast
      // diffs must do the same — a payload missing winningScore etc. means
      // "unchanged", not "changed to undefined" (which would toast
      // "Winning score: undefined").
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        status: 'lobby', winningScore: 6000, turnDuration: 45,
        reconnectTimeout: 60, enforcedDiceMode: null, toasts: [],
      });

      mockOnHandlers['gameState']({ status: 'lobby', players: [] });

      expect(useGameStore.getState().toasts).toEqual([]);
    });

    it('does not toast when enforcedDiceMode is unchanged', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      useGameStore.setState({ roomId: 'R1', status: 'lobby', enforcedDiceMode: 'physical', toasts: [] });

      // Every other lobby-diffed field must also match the current state,
      // or its own toast fires and masks what this test is checking.
      mockOnHandlers['gameState']({
        status: 'lobby', enforcedDiceMode: 'physical', players: [],
        winningScore: s.winningScore, turnDuration: s.turnDuration,
        reconnectTimeout: s.reconnectTimeout, initialCards: s.initialCards,
      });

      expect(useGameStore.getState().toasts).toEqual([]);
    });

    it('toasts when the host switches the ruleset in the lobby', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({ roomId: 'R1', status: 'lobby', ruleset: 'modernized', toasts: [] });

      mockOnHandlers['gameState']({ status: 'lobby', ruleset: 'classic', players: [] });

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Classic'))).toBe(true);
      expect(useGameStore.getState().ruleset).toBe('classic');
    });

    it('does not toast when the ruleset is unchanged', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      useGameStore.setState({ roomId: 'R1', status: 'lobby', ruleset: 'classic', toasts: [] });

      mockOnHandlers['gameState']({
        status: 'lobby', ruleset: 'classic', players: [],
        winningScore: s.winningScore, turnDuration: s.turnDuration,
        reconnectTimeout: s.reconnectTimeout, initialCards: s.initialCards,
        enforcedDiceMode: s.enforcedDiceMode,
      });

      expect(useGameStore.getState().toasts).toEqual([]);
    });
  });

  describe('gameState sync allowlist (STORE-SEC-1)', () => {
    it('only applies known game-state fields from the server, ignoring anything else in the payload', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // setMode spreads clearRoomState, so the seat has to come after it.
      useGameStore.setState({ roomId: 'R1' });
      const originalStartGame = useGameStore.getState().startGame;

      // A compromised/buggy server sending an extra, unexpected key (here,
      // even an action name) must not reach the store — only fields on the
      // allowlist may be applied.
      mockOnHandlers['gameState']({
        status: 'lobby', players: [], winningScore: 9999,
        startGame: 'hacked', someUnknownField: 'hacked',
      } as never);

      expect(useGameStore.getState().winningScore).toBe(9999);
      expect(useGameStore.getState().startGame).toBe(originalStartGame);
      expect((useGameStore.getState() as unknown as Record<string, unknown>).someUnknownField).toBeUndefined();
    });
  });

  describe('online turn timer', () => {
    // Turn expiry is authoritative on the server (server/index.ts startServerTurnTimer /
    // advanceTurnOnTimeout) so it still fires even if the host disconnects or backgrounds
    // their tab. The client's countdown is display-only: it must NOT call nextTurn/pushState
    // itself when it hits 0, for host or non-host alike — it just stops and waits for the
    // server's gameState push.
    it.each([
      ['host', true],
      ['non-host', false],
    ])('%s client does not auto-advance the turn when its local countdown hits 0', (_label, isHost) => {
      vi.useFakeTimers();
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      // currentPlayerIndex/currentCard vary per iteration (rather than being fixed)
      // so syncOnlineTimers always sees a "new turn" — the module-level
      // turnTimerPlayerIndex/turnTimerCard tracking vars from the previous
      // it.each iteration would otherwise make this a no-op on the second run.
      useGameStore.setState({
        isHost, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: isHost ? 0 : 1, status: 'playing', finished: false,
        turnDuration: 2, currentCard: isHost ? '200' : '300', cards: ['200'], initialCards: { 200: 5 },
        round: 1, chartValues: [[], []], chartLabels: [], chartNames: ['Alice', 'Bob'],
      });

      // Kick the turn timer off as syncOnlineTimers would after a state push.
      useGameStore.getState().syncOnlineTimers();
      expect(useGameStore.getState().turnTimeRemaining).toBe(2);

      mockEmit.mockClear();
      vi.advanceTimersByTime(2000);

      // Countdown stops at 0, but no local pushState/turn-advance is triggered —
      // that would race with (or duplicate) the server's own authoritative advance.
      expect(useGameStore.getState().turnTimeRemaining).toBe(0);
      expect(useGameStore.getState().currentPlayerIndex).toBe(isHost ? 0 : 1);
      expect(mockEmit).not.toHaveBeenCalledWith('pushState', expect.any(Object));

      // Advancing further must not somehow retrigger anything (interval was cleared).
      vi.advanceTimersByTime(5000);
      expect(mockEmit).not.toHaveBeenCalledWith('pushState', expect.any(Object));

      vi.useRealTimers();
    });
  });

  describe('liveTurnState', () => {
    it('setLiveTurnState stores the snapshot locally', () => {
      const snapshot = { turnScore: 200, keptDice: [{ val: 1 }], currentRoll: [] };
      useGameStore.getState().setLiveTurnState(snapshot);
      expect(useGameStore.getState().liveTurnState).toEqual(snapshot);
    });

    it('setLiveTurnState pushes via the dedicated liveTurnState event when online, not the full pushState event', () => {
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

      // A dedicated, small event — not the full state-bundle 'pushState' event
      // (see server/socketHandlers.ts's separate 'liveTurnState' handler).
      expect(mockEmit).toHaveBeenCalledWith('liveTurnState', { roomId: 'ROOM1', liveTurnState: snapshot });
      expect(mockEmit).not.toHaveBeenCalledWith('pushState', expect.anything());
    });

    it('setLiveTurnState does not include playerName in the liveTurnState pushed to the server', () => {
      // playerName is only persisted in localStorage, never sent over the wire
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');
      useGameStore.setState({
        isHost: false, roomId: 'ROOM1', myName: 'Alice', deviceId: 'dev-alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        currentPlayerIndex: 0, status: 'playing',
      });
      mockEmit.mockClear();

      const snapshot = { turnScore: 350, keptDice: [], currentRoll: [] };
      useGameStore.getState().setLiveTurnState(snapshot);

      const pushCall = mockEmit.mock.calls.find(([ev]) => ev === 'liveTurnState');
      expect(pushCall).toBeDefined();
      expect(pushCall![1].liveTurnState).not.toHaveProperty('playerName');
      // Also verify in-memory store has no playerName on liveTurnState
      expect(useGameStore.getState().liveTurnState).not.toHaveProperty('playerName');
    });

    it('the liveTurnState socket event merges into the store without touching other fields', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.setState({
        isOnline: true, roomId: 'ROOM1', myName: 'Alice',
        players: [makeOnlinePlayer('Alice'), makeOnlinePlayer('Bob')],
        round: 3, historyLog: [],
      });

      const incoming = { turnScore: 500, keptDice: [{ val: 6 }], currentRoll: [] };
      mockOnHandlers['liveTurnState']({ liveTurnState: incoming });

      expect(useGameStore.getState().liveTurnState).toEqual(incoming);
      // Untouched by the targeted merge — proves this doesn't run through the
      // full 'gameState' Object.assign path.
      expect(useGameStore.getState().round).toBe(3);
      expect(useGameStore.getState().myName).toBe('Alice');
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

    it('endGame resets cards, chart data and previous-turn fields, not just round/status', () => {
      // startGame() already resets all of these before a new game; endGame()
      // previously left them stale while sitting in the lobby between games —
      // cosmetic today (nothing renders them in the lobby), but a foot-gun for
      // any future lobby UI that reads them (e.g. a "last game" recap).
      useGameStore.setState({
        cards: ['200', '300'],
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [{ name: 'Alice', score: 6000 }],
        previousWasBust: true,
        previousHighestTurnScore: 2000,
        chartValues: [[0, 500], [0, 300]],
        chartNames: ['Alice', 'Bob'],
        chartLabels: [1],
      });

      useGameStore.getState().endGame();

      const state = useGameStore.getState();
      expect(state.cards).toEqual([]);
      expect(state.previousCard).toBeNull();
      expect(state.previousScore).toBeNull();
      expect(state.previousLeaders).toBeNull();
      expect(state.previousWasBust).toBe(false);
      expect(state.previousHighestTurnScore).toBe(0);
      expect(state.chartValues).toEqual([]);
      expect(state.chartNames).toEqual([]);
      expect(state.chartLabels).toEqual([]);
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
        previousPlayerName: 'Bob',
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

  describe('nameConflictWithDisconnected toast', () => {
    it('tells the host which disconnected player\'s name was contested', () => {
      useGameStore.getState().connectSocket('http://localhost:3000');
      useGameStore.getState().setMode('online');

      mockOnHandlers['nameConflictWithDisconnected']('Bob');

      const messages = useGameStore.getState().toasts.map(t => t.message);
      expect(messages.some(m => m.includes('Bob'))).toBe(true);
    });
  });

  describe('drawCardMidTurn (classic chains)', () => {
    it('pops the deck, sets the drawn card as current, and returns it', () => {
      useGameStore.setState({
        currentPlayerIndex: 0,
        players: [{ name: 'Alice', score: 0 } as never],
        currentCard: '300',
        cards: ['x2', 'Stop'],
        finished: false,
      });
      const drawn = useGameStore.getState().drawCardMidTurn();
      expect(drawn).toBe('x2');
      const s = useGameStore.getState();
      expect(s.currentCard).toBe('x2');
      expect(s.cards).toEqual(['Stop']);
    });

    it('rebuilds the deck from initialCards when it runs empty', () => {
      useGameStore.setState({
        currentPlayerIndex: 0,
        players: [{ name: 'Alice', score: 0 } as never],
        currentCard: '300',
        cards: [],
        initialCards: { '200': 2 },
        finished: false,
      });
      const drawn = useGameStore.getState().drawCardMidTurn();
      expect(drawn).toBe('200');
      expect(useGameStore.getState().cards).toEqual(['200']);
    });

    it('refuses when no turn is active or the game is finished', () => {
      useGameStore.setState({ currentPlayerIndex: null, cards: ['200'] });
      expect(useGameStore.getState().drawCardMidTurn()).toBeNull();
      useGameStore.setState({ currentPlayerIndex: 0, players: [{ name: 'A', score: 0 } as never], finished: true });
      expect(useGameStore.getState().drawCardMidTurn()).toBeNull();
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

      useGameStore.setState({
        players: namedPlayers('TestPlayer'),
        currentPlayerIndex: 0
      });

      useGameStore.getState().setLiveTurnState(turnState);

      const saved = localStorage.getItem('tutto_dice_turn_state');
      expect(saved).toBeDefined();
      // roomId: null, round: 1, currentCard: null after reset() in beforeEach.
      expect(JSON.parse(saved!)).toEqual({ ...turnState, playerName: 'TestPlayer', turnKey: 'local:1:0:none:modernized' });
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

  describe('init state restoration', () => {
    it('clears tutto_dice_turn_state if the active player does not match the cached player name in local mode', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice',
      }));

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('keeps tutto_dice_turn_state if the active player matches the cached player name in local mode', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Bob',
      }));

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state for legacy local saves that have no playerName', () => {
      // Old saves written before this fix have no playerName field — we must not drop them
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice'),
        currentPlayerIndex: 0,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 500,
        // no playerName
      }));

      useGameStore.getState().init('test-device-id');

      // Validation only fires when playerName is present; legacy saves are left untouched
      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state when an online reconnect is pending, even if names mismatch the local roster', () => {
      // init() runs at app mount, BEFORE the reconnect popup can set
      // mode='online' — so the pending session (restored from sessionStorage
      // inside init itself) is the only signal that the cache belongs to an
      // online game. Judging it against the local roster here would delete the
      // reconnecting player's in-progress turn; DiceGame's turnKey check
      // (which runs after the reconnect against real state) is the validator
      // for this path.
      sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: 'ROOM1', myName: 'Alice' }));
      useGameStore.setState({
        mode: 'local', // what init() actually observes at mount
        players: namedPlayers('Carol', 'Bob'),
        currentPlayerIndex: 1,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice', // mismatches the local roster, belongs to ROOM1
      }));

      useGameStore.getState().init('test-device-id');

      // Should NOT be cleared — a pending online reconnect owns this cache
      expect(localStorage.getItem('tutto_dice_turn_state')).not.toBeNull();
    });

    it('does not delete tutto_dice_turn_state when the saved local game\'s restore was postponed for a join link', () => {
      // Same reasoning as the pending-reconnect case above, from the other
      // side: the roster this cache would be judged against is still on disk
      // rather than in state, so checking it here would delete the half-rolled
      // turn of the very game being kept for later.
      localStorage.setItem('tutto_local_game', JSON.stringify({
        players: [{ name: 'Alice', color: '#ff0000', score: 100 }],
        status: 'playing', currentPlayerIndex: 0, finished: false, round: 2,
      }));
      const cachedTurn = JSON.stringify({ turnScore: 250, playerName: 'Alice' });
      localStorage.setItem('tutto_dice_turn_state', cachedTurn);
      useGameStore.setState({ mode: 'online' }); // what Home's join-link effect already did

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBe(cachedTurn);
    });

    it('still clears an orphaned tutto_dice_turn_state when there is no saved local game to postpone', () => {
      // Only a POSTPONED restore protects the cache. With no save at all there
      // is no game coming back for it, so the ordinary ownership check applies
      // even though a join link has already switched the mode.
      localStorage.removeItem('tutto_local_game');
      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 250,
        playerName: 'Alice',
      }));
      useGameStore.setState({ mode: 'online' });

      useGameStore.getState().init('test-device-id');

      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('does not crash when currentPlayerIndex is null during init', () => {
      useGameStore.setState({
        mode: 'local',
        players: namedPlayers('Alice'),
        currentPlayerIndex: null,
      });

      localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
        turnScore: 1000,
        playerName: 'Alice',
      }));

      expect(() => useGameStore.getState().init('test-device-id')).not.toThrow();
      // activePlayer is null → mismatch → cache cleared
      expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    });

    it('restores hapticsEnabled from localStorage', () => {
      localStorage.setItem('tutto_hapticsEnabled', 'false');
      useGameStore.getState().init('test-device-id');
      expect(useGameStore.getState().hapticsEnabled).toBe(false);
    });
  });

  describe('validateOnlineConfig (stored online config loading)', () => {
    it('applies a fully valid stored config when switching to online mode', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 8000, randomOrder: false, turnDuration: 60, reconnectTimeout: 120,
        initialCards: { '200': 3, Stop: 2 },
      }));
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      expect(s.winningScore).toBe(8000);
      expect(s.randomOrder).toBe(false);
      expect(s.turnDuration).toBe(60);
      expect(s.reconnectTimeout).toBe(120);
      expect(s.initialCards).toEqual({ '200': 3, Stop: 2 });
    });

    it('drops out-of-range and wrong-typed fields, keeping the defaults', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 500,        // below the 1000 minimum
        randomOrder: 'yes',       // wrong type
        turnDuration: 5,          // server only accepts 0 or 10-600
        reconnectTimeout: 99999,  // above 3600
      }));
      useGameStore.getState().setMode('online');
      const s = useGameStore.getState();
      expect(s.winningScore).toBe(6000);
      expect(s.randomOrder).toBe(true);
      expect(s.turnDuration).toBe(120);
      expect(s.reconnectTimeout).toBe(60);
    });

    it('accepts 0 as the explicit "disabled" value for both timers', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        turnDuration: 0, reconnectTimeout: 0,
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().turnDuration).toBe(0);
      expect(useGameStore.getState().reconnectTimeout).toBe(0);
    });

    it('keeps only the valid initialCards entries', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        // Bogus is an unknown card, 100 exceeds the 99 cap, -1 is negative
        initialCards: { '200': 3, Bogus: 4, '300': 100, Stop: -1 },
      }));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().initialCards).toEqual({ '200': 3 });
    });

    it('keeps the default deck when no initialCards entry is valid', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        initialCards: { Bogus: 4 },
      }));
      useGameStore.getState().setMode('online');
      const cards = useGameStore.getState().initialCards;
      expect(cards.Stop).toBe(10);
      expect(cards.Kleeblatt).toBe(1);
    });

    it('keeps the default deck when the stored initialCards is all zeros (would leave currentCard permanently null)', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        initialCards: { Stop: 0, Kleeblatt: 0, '200': 0 },
      }));
      useGameStore.getState().setMode('online');
      const cards = useGameStore.getState().initialCards;
      expect(cards.Stop).toBe(10);
      expect(cards.Kleeblatt).toBe(1);
    });

    it('ignores a non-object stored config', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify('garbage'));
      useGameStore.getState().setMode('online');
      expect(useGameStore.getState().winningScore).toBe(6000);
    });

    it('joinRoom transmits only the validated fields from the stored config', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({
        winningScore: 7000,
        turnDuration: 3,   // invalid — must not be transmitted
        bogus: true,       // unknown — must not be transmitted
      }));
      void useGameStore.getState().joinRoom('room-x', 'Alice');
      const call = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(call).toBeDefined();
      expect(call[1].initialConfig).toEqual({ winningScore: 7000 });
    });

    it('joinRoom sends no initialConfig when the stored config is entirely invalid', () => {
      localStorage.setItem('tutto_online_config', JSON.stringify({ turnDuration: 3 }));
      void useGameStore.getState().joinRoom('room-y', 'Alice');
      const call = mockEmit.mock.calls.find(c => c[0] === 'joinRoom');
      expect(call).toBeDefined();
      expect(call[1].initialConfig).toBeUndefined();
    });
  });

  // Every previous-turn field describes the same single turn, so the three
  // sites that end one clear them together — a site that clears some but not
  // others leaves a half-erased turn for undo and for the broadcast.
  describe.each([
    ['startGame', () => { useGameStore.getState().startGame(); }],
    ['endGame', () => { useGameStore.getState().endGame(); }],
    ['undo', () => { useGameStore.getState().undo(); }],
  ])('%s leaves no previous turn behind', (_label, act) => {
    it('clears every previous* field', () => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      useGameStore.getState().startGame();
      useGameStore.setState({
        // Bob is up in round 2, so Alice's turn is genuinely undoable —
        // calculateUndo refuses outright in round 1 (nothing to wind back to).
        currentPlayerIndex: 1,
        round: 2,
        currentCard: '200',
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [{ name: 'Bob', score: 10 } as Player],
        previousWasBust: true,
        previousHighestTurnScore: 1200,
        previousHighestFeuerwerkTurnScore: 800,
        previousHighestX2TurnScore: 600,
        previousPlayerName: 'Alice',
        previousTurnSummary: { cards: [{ card: 'Kniffel', completed: true }], tuttoCount: 1, plusMinusScores: [], ended: 'banked' },
      });

      act();

      const s = useGameStore.getState();
      expect(s.previousCard).toBeNull();
      expect(s.previousScore).toBeNull();
      expect(s.previousLeaders).toBeNull();
      expect(s.previousWasBust).toBe(false);
      expect(s.previousHighestTurnScore).toBe(0);
      expect(s.previousHighestFeuerwerkTurnScore).toBe(0);
      expect(s.previousHighestX2TurnScore).toBe(0);
      expect(s.previousPlayerName).toBeNull();
      expect(s.previousTurnSummary).toBeNull();
    });
  });

  describe('storage refusing to cooperate', () => {
    afterEach(() => {
      restoreStorage();
    });

    // The local-save subscriber writes synchronously inside EVERY store
    // mutation, so a refused write surfaces from whatever caused it — a turn
    // commit, a toast — rather than merely losing the save.
    it.each([
      ['a refused write', () => failStorageMethods('localStorage', ['setItem'])],
      ['blocked site data', () => blockStorage('localStorage')],
    ])('keeps mutating state through %s', (_label, breakStorage) => {
      useGameStore.getState().addPlayer('Alice');
      useGameStore.getState().addPlayer('Bob');
      breakStorage();

      expect(() => useGameStore.getState().startGame()).not.toThrow();
      // Pinned: startGame shuffles, and the engine substitutes its own score
      // for a Kniffel/Plus_Minus (or wins outright on a Kleeblatt), none of
      // which this test is about.
      useGameStore.setState({ currentCard: '200' });
      expect(() => useGameStore.getState().nextTurn(300, true)).not.toThrow();
      expect(() => useGameStore.getState().addToast('still here')).not.toThrow();
      expect(useGameStore.getState().players[0].score).toBe(300);
    });

    it('still restores nothing rather than throwing when reads are refused', () => {
      blockStorage('localStorage');
      blockStorage('sessionStorage');

      expect(() => useGameStore.getState().init('device-1')).not.toThrow();
      expect(useGameStore.getState().deviceId).toBe('device-1');
    });

    it('keeps the live dice snapshot flowing when its cache write is refused', () => {
      failStorageMethods('localStorage', ['setItem']);

      expect(() => useGameStore.getState().setLiveTurnState({
        turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
      })).not.toThrow();
      expect(useGameStore.getState().liveTurnState?.turnScore).toBe(50);
    });
  });

});
