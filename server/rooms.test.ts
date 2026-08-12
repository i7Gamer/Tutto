/**
 * @vitest-environment node
 *
 * In-process unit tests for the pure room-state helpers in rooms.ts. The E2E
 * socket suites (sockets.test.ts, turnTimer.test.ts) prove the same behavior
 * holds over the wire via kick/leave/disconnect-timeout; these pin the two
 * trickiest branches — turn-order bookkeeping on active-player removal, and
 * the turn-timer countdown formula — directly and cheaply, and show up in
 * coverage (the E2E suites run the real server as a spawned subprocess,
 * which coverage instrumentation can't see).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleActivePlayerRemoved, calculateRemainingTurnTime, createRoom, deleteRoom, rooms } from './rooms';
import type { Room, RoomState, ServerPlayer } from './roomTypes';

const makePlayer = (name: string, overrides: Partial<ServerPlayer> = {}): ServerPlayer => ({
  name,
  deviceId: `dev-${name}`,
  socketId: `sock-${name}`,
  score: 0,
  times1000PointsDeducted: 0,
  timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0,
  timesKniffelFailed: 0,
  timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0,
  timesPlusMinusFailed: 0,
  timesFeuerwerkReceived: 0,
  timesSkipped: 0,
  timesx2Received: 0,
  totalTurns: 0,
  busts: 0,
  feuerwerkBusts: 0,
  x2Busts: 0,
  feuerwerkPointsScored: 0,
  x2PointsScored: 0,
  position: 0,
  color: '#ff0000',
  disconnected: false,
  ...overrides,
});

// handleActivePlayerRemoved is always called AFTER the caller has already
// spliced the removed player out of state.players — `players` here is the
// POST-splice roster, and `removedIdx` is the index the removed player used
// to occupy. This mirrors every real call site (kickPlayer, handlePlayerLeave,
// the disconnect-timeout callback).
const makeRoom = (playersAfterSplice: string[], overrides: Partial<RoomState> = {}): Room => {
  const room = createRoom('sock-host');
  const state = room.state;
  state.players = playersAfterSplice.map(n => makePlayer(n));
  state.chartValues = playersAfterSplice.map(() => [100]);
  state.chartNames = [...playersAfterSplice];
  Object.assign(state, overrides);
  return room;
};

describe('handleActivePlayerRemoved', () => {
  describe('chart array shrinking', () => {
    it('splices the removed index out of chartValues and chartNames', () => {
      // Original roster [Alice, Bob, Carol], Bob (idx 1) removed. players is
      // already post-splice ([Alice, Carol]); chartValues/chartNames still
      // hold all 3 entries, mirroring the caller's actual sequencing.
      const room = makeRoom(['Alice', 'Carol'], { currentPlayerIndex: null });
      room.state.chartValues = [[100], [200], [300]];
      room.state.chartNames = ['Alice', 'Bob', 'Carol'];
      handleActivePlayerRemoved(room, 1);
      expect(room.state.chartValues).toEqual([[100], [300]]);
      expect(room.state.chartNames).toEqual(['Alice', 'Carol']);
    });

    it('leaves chart arrays untouched when removedIdx is out of bounds', () => {
      const room = makeRoom(['Alice'], { currentPlayerIndex: null });
      room.state.chartValues = [[100]];
      room.state.chartNames = ['Alice'];
      handleActivePlayerRemoved(room, 5);
      expect(room.state.chartValues).toEqual([[100]]);
      expect(room.state.chartNames).toEqual(['Alice']);
    });

    it('does not throw when chartValues/chartNames are not arrays', () => {
      const room = makeRoom(['Alice'], { currentPlayerIndex: null });
      (room.state as unknown as { chartValues: unknown }).chartValues = undefined;
      (room.state as unknown as { chartNames: unknown }).chartNames = undefined;
      expect(() => handleActivePlayerRemoved(room, 0)).not.toThrow();
    });
  });

  describe('no active game (currentPlayerIndex === null)', () => {
    it('returns without touching turn-order fields', () => {
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: null,
        previousCard: 'Stop',
        turnStartTime: null,
      });
      handleActivePlayerRemoved(room, 0);
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.previousCard).toBe('Stop');
      expect(room.state.turnStartTime).toBeNull();
    });
  });

  describe('removed player was before the active player (removedIdx < curIdx)', () => {
    it('shifts currentPlayerIndex down by one and changes nothing else', () => {
      // Original [Alice, Bob, Carol], Carol (idx 2) was active; Alice (idx 0) removed.
      const room = makeRoom(['Bob', 'Carol'], {
        currentPlayerIndex: 2,
        previousCard: 'x2',
        previousScore: 300,
        currentCard: 'Stop',
        cards: ['200'],
        round: 3,
        turnStartTime: 12345,
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });
      handleActivePlayerRemoved(room, 0);
      expect(room.state.currentPlayerIndex).toBe(1);
      // No mid-turn reset — the active player themselves wasn't touched.
      expect(room.state.previousCard).toBe('x2');
      expect(room.state.previousScore).toBe(300);
      expect(room.state.currentCard).toBe('Stop');
      expect(room.state.cards).toEqual(['200']);
      expect(room.state.round).toBe(3);
      expect(room.state.turnStartTime).toBe(12345);
      expect(room.state.liveTurnState).not.toBeNull();
    });

    it('syncs turnTimerState to the shifted index so the next pushState does not reset the turn', () => {
      // Bob's ongoing turn (originally idx 2, card Stop) was tracked by the
      // turn-change detector. After Alice's removal shifts Bob to idx 1, the
      // tracker must follow — otherwise the next pushState compares idx 1
      // against the stale idx 2, misreads it as a new turn, and re-arms the
      // timer with a fresh full duration mid-turn.
      const room = makeRoom(['Bob', 'Carol'], {
        currentPlayerIndex: 2,
        currentCard: 'Stop',
        turnStartTime: 12345,
      });
      room.turnTimerState = { lastCard: 'Stop', lastPlayerIndex: 2 };
      handleActivePlayerRemoved(room, 0);
      expect(room.turnTimerState.lastPlayerIndex).toBe(1);
      expect(room.turnTimerState.lastCard).toBe('Stop');
    });
  });

  describe('removed player was after the active player (removedIdx > curIdx)', () => {
    it('leaves currentPlayerIndex and turn state completely unchanged', () => {
      // Original [Alice, Bob, Carol], Alice (idx 0) active; Carol (idx 2) removed.
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: 0,
        previousCard: 'Kniffel',
        currentCard: '500',
        cards: ['600'],
        round: 5,
        turnStartTime: 99999,
      });
      handleActivePlayerRemoved(room, 2);
      expect(room.state.currentPlayerIndex).toBe(0);
      expect(room.state.previousCard).toBe('Kniffel');
      expect(room.state.currentCard).toBe('500');
      expect(room.state.cards).toEqual(['600']);
      expect(room.state.round).toBe(5);
      expect(room.state.turnStartTime).toBe(99999);
    });
  });

  describe('removed player WAS the active player (removedIdx === curIdx)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('mid-order (not last): index stays put (now pointing at the shifted-in next player), no round bump', () => {
      // Original [Alice, Bob, Carol], Alice (idx 0) active and removed.
      // Post-splice players = [Bob, Carol], length 2. removedIdx(0) !== length(2) -> not last.
      const room = makeRoom(['Bob', 'Carol'], {
        currentPlayerIndex: 0,
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [{ name: 'Bob', score: 10 } as unknown as ServerPlayer],
        previousPlayerName: 'Alice',
        previousWasBust: true,
        previousHighestTurnScore: 1200,
        previousHighestFeuerwerkTurnScore: 800,
        previousHighestX2TurnScore: 600,
        previousTurnSummary: { cards: [{ card: 'Kniffel', completed: true }], tuttoCount: 1, plusMinusScores: [], ended: 'banked' },
        round: 4,
        cards: ['200', '300'],
        currentCard: 'Kniffel',
        liveTurnState: { turnScore: 20, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });
      // chartValues/chartNames still hold all 3 PRE-splice entries (see the
      // "chart array shrinking" tests above) — makeRoom's default sizes them
      // for the post-splice roster, which is wrong for this function's own
      // unconditional splice at the top.
      room.state.chartValues = [[100], [100], [100]];
      room.state.chartNames = ['Alice', 'Bob', 'Carol'];

      handleActivePlayerRemoved(room, 0);

      expect(room.state.currentPlayerIndex).toBe(0); // now points at Bob, shifted into Alice's slot
      expect(room.state.round).toBe(4); // unchanged — not the last player in the order
      expect(room.state.previousCard).toBeNull();
      expect(room.state.previousScore).toBeNull();
      expect(room.state.previousLeaders).toBeNull();
      // Undo now keys off previousPlayerName (see calculateUndo in
      // coreGameEngine.ts) — it must be cleared alongside the other previous*
      // bookkeeping here, or a later undo would still try to look up Alice
      // (no longer seated) instead of correctly refusing.
      expect(room.state.previousPlayerName).toBeNull();
      expect(room.state.liveTurnState).toBeNull();
      expect(room.state.turnStartTime).toBe(Date.now());
      // Every previous-turn field describes the same one turn, so they clear
      // together. previousTurnSummary used to be left behind here — inert,
      // because undo refuses without previousCard, but a half-erased turn
      // riding every subsequent broadcast all the same.
      expect(room.state.previousTurnSummary).toBeNull();
      expect(room.state.previousWasBust).toBe(false);
      expect(room.state.previousHighestTurnScore).toBe(0);
      expect(room.state.previousHighestFeuerwerkTurnScore).toBe(0);
      expect(room.state.previousHighestX2TurnScore).toBe(0);
      // A new card was drawn for the player now occupying the active slot.
      expect(room.state.cards).toEqual(['300']);
      expect(room.state.currentCard).toBe('200');
      // No round was forced past, so no chart data point should be pushed.
      expect(room.state.chartLabels).toEqual([]);
      expect(room.state.chartValues).toEqual([[100], [100]]);
    });

    it('last in order: index wraps to 0 and the round advances', () => {
      // Original [Alice, Bob, Carol], Carol (idx 2) active and removed.
      // Post-splice players = [Alice, Bob], length 2. removedIdx(2) === length(2) -> last.
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: 2,
        previousCard: 'x2',
        previousScore: 400,
        round: 7,
        cards: ['Stop'],
        currentCard: 'x2',
      });
      // chartValues/chartNames still hold all 3 PRE-splice entries (see the
      // "chart array shrinking" tests above); give the players distinct scores
      // so the pushed chart point is distinguishable from the seeded [100].
      room.state.chartValues = [[100], [100], [100]];
      room.state.chartNames = ['Alice', 'Bob', 'Carol'];
      room.state.players[0].score = 250;
      room.state.players[1].score = 175;

      handleActivePlayerRemoved(room, 2);

      expect(room.state.currentPlayerIndex).toBe(0);
      expect(room.state.round).toBe(8); // advanced — the removed player was last to act this round
      expect(room.state.previousCard).toBeNull();
      expect(room.state.turnStartTime).toBe(Date.now());
      expect(room.state.currentCard).toBe('Stop');
      expect(room.state.cards).toEqual([]);
      // The round the removal forced past (7, before it advanced to 8) still
      // gets a chart data point — otherwise the end-screen score-per-round
      // chart silently comes up one round short.
      expect(room.state.chartLabels).toEqual([7]);
      expect(room.state.chartValues).toEqual([[100, 250], [100, 175]]);
    });

    it('last in order AND a sole leader already reached winningScore: ends the game instead of drawing a new round', () => {
      // Original [Alice, Bob, Carol], Carol (idx 2) active and removed.
      // Post-splice players = [Alice, Bob], length 2. removedIdx(2) === length(2) -> last.
      // Alice already sits at/above the default winningScore (6000) and is the
      // sole leader — calculateNextTurn would end the game at this exact round
      // boundary (see coreGameEngine.ts), and this removal-forced round
      // boundary must do the same instead of handing out a free extra round.
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: 2,
        previousCard: 'x2',
        previousScore: 400,
        round: 5,
        cards: ['Stop'],
        currentCard: 'x2',
      });
      room.state.chartValues = [[100], [100], [100]];
      room.state.chartNames = ['Alice', 'Bob', 'Carol'];
      room.state.players[0].score = 6000;
      room.state.players[1].score = 3000;
      room.gameActualStartTime = Date.now() - 12_000;

      handleActivePlayerRemoved(room, 2);

      expect(room.state.finished).toBe(true);
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.currentCard).toBeNull();
      expect(room.state.turnStartTime).toBeNull();
      expect(room.state.round).toBe(5); // NOT advanced — the game ended at this boundary
      // The final round still gets its chart data point.
      expect(room.state.chartLabels).toEqual([5]);
      expect(room.state.chartValues).toEqual([[100, 6000], [100, 3000]]);
      // The elapsed-time bookkeeping calculateNextTurn's callers do on game over.
      expect(room.state.gameTimeInSeconds).toBe(12);
      expect(room.gameActualStartTime).toBeNull();
      expect(room.turnTimerState!.lastCard).toBeNull();
      expect(room.turnTimerState!.lastPlayerIndex).toBeNull();
    });

    it('last in order but leaders are tied at/above winningScore: game continues (no sole leader)', () => {
      // Same boundary, but Alice and Bob are tied — calculateNextTurn's own
      // `leaders.length === 1` requirement means a tie never ends the game,
      // so this removal-forced boundary must not end it either.
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: 2,
        round: 5,
        cards: ['Stop'],
        currentCard: 'x2',
      });
      room.state.chartValues = [[100], [100], [100]];
      room.state.chartNames = ['Alice', 'Bob', 'Carol'];
      room.state.players[0].score = 6000;
      room.state.players[1].score = 6000;

      handleActivePlayerRemoved(room, 2);

      expect(room.state.finished).toBe(false);
      expect(room.state.round).toBe(6);
      expect(room.state.currentPlayerIndex).toBe(0);
      expect(room.state.currentCard).toBe('Stop');
    });

    it('syncs turnTimerState to the freshly drawn card and new index', () => {
      // The removed player's turn (card Kniffel, idx 0) was the tracked turn.
      // The player shifted into the slot starts a NEW turn with a new card —
      // the tracker must adopt it so the pushState that follows the removal
      // does not double-reset turnStartTime.
      const room = makeRoom(['Bob', 'Carol'], {
        currentPlayerIndex: 0,
        currentCard: 'Kniffel',
        cards: ['200', '300'],
      });
      room.turnTimerState = { lastCard: 'Kniffel', lastPlayerIndex: 0 };

      handleActivePlayerRemoved(room, 0);

      expect(room.turnTimerState.lastCard).toBe(room.state.currentCard);
      expect(room.turnTimerState.lastCard).toBe('200');
      expect(room.turnTimerState.lastPlayerIndex).toBe(0);
    });

    it('creates turnTimerState when the room never had one', () => {
      const room = makeRoom(['Bob'], {
        currentPlayerIndex: 0,
        currentCard: '500',
        cards: ['600'],
      });
      expect(room.turnTimerState).toBeNull();

      handleActivePlayerRemoved(room, 0);

      expect(room.turnTimerState).not.toBeNull();
      expect(room.turnTimerState!.lastCard).toBe('600');
      expect(room.turnTimerState!.lastPlayerIndex).toBe(0);
    });

    it('draws from a freshly built deck when the pre-existing deck is exhausted', () => {
      const room = makeRoom(['Alice'], {
        currentPlayerIndex: 1,
        cards: [], // exhausted
        currentCard: 'Stop',
        initialCards: { Stop: 2 },
      });

      handleActivePlayerRemoved(room, 1);

      // buildDeck({Stop: 2}) was used to refill — both cards are 'Stop', so
      // the draw is deterministic: one drawn as currentCard, one left in cards.
      expect(room.state.currentCard).toBe('Stop');
      expect(room.state.cards).toEqual(['Stop']);
    });

    it('last player removed leaves zero players: currentPlayerIndex still resolves to 0, round still advances', () => {
      // Single-player edge case: players=[Alice], Alice (idx 0) active and removed.
      // Post-splice players = [], length 0. removedIdx(0) === length(0) -> last.
      const room = makeRoom([], {
        currentPlayerIndex: 0,
        round: 1,
        cards: ['200'],
        currentCard: 'Stop',
      });

      expect(() => handleActivePlayerRemoved(room, 0)).not.toThrow();
      expect(room.state.currentPlayerIndex).toBe(0); // 0 % max(1, 0) === 0 % 1 === 0
      expect(room.state.round).toBe(2);
    });
  });
});

describe('calculateRemainingTurnTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeTimerRoom = (stateOverrides: Partial<RoomState>): Room => {
    const room = createRoom('sock-host');
    Object.assign(room.state, stateOverrides);
    return room;
  };

  it('returns null when no turn is in progress (turnStartTime is null)', () => {
    const room = makeTimerRoom({ turnStartTime: null, turnDuration: 120 });
    expect(calculateRemainingTurnTime(room)).toBeNull();
  });

  it('returns null when the timer is disabled (turnDuration === 0), even mid-turn', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 0 });
    expect(calculateRemainingTurnTime(room)).toBeNull();
  });

  it('returns the full duration right when a turn starts', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 120, currentCard: null });
    expect(calculateRemainingTurnTime(room)).toBe(120);
  });

  it('counts down as time elapses', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 120, currentCard: null });
    vi.advanceTimersByTime(30_000);
    expect(calculateRemainingTurnTime(room)).toBe(90);
  });

  it('never goes negative once the duration has fully elapsed', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 10, currentCard: null });
    vi.advanceTimersByTime(60_000);
    expect(calculateRemainingTurnTime(room)).toBe(0);
  });

  it('applies the Feuerwerk 3x multiplier', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Feuerwerk' });
    expect(calculateRemainingTurnTime(room)).toBe(300);
    vi.advanceTimersByTime(50_000);
    expect(calculateRemainingTurnTime(room)).toBe(250);
  });

  it('applies the Kleeblatt 2x multiplier', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Kleeblatt' });
    expect(calculateRemainingTurnTime(room)).toBe(200);
  });

  it('applies no multiplier for a card with no configured multiplier', () => {
    const room = makeTimerRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Stop' });
    expect(calculateRemainingTurnTime(room)).toBe(100);
  });
});

describe('deleteRoom', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the room from the registry', () => {
    rooms['DELETE_ROOM_TEST_1'] = createRoom('sock-host');
    deleteRoom('DELETE_ROOM_TEST_1');
    expect(rooms['DELETE_ROOM_TEST_1']).toBeUndefined();
  });

  it('does not throw when the room does not exist', () => {
    expect(() => deleteRoom('NEVER_EXISTED')).not.toThrow();
  });

  // The bug this guards against: a disconnect-timeout timer captures its
  // roomId in closure and looks the room up FRESH (by id) when it fires (see
  // socketHandlers.ts). If deleteRoom leaves that timer armed, and a new room
  // is later created under the same id, the stale timer fires against that
  // unrelated new room instead of a no-op.
  it('cancels a pending disconnectTimers entry so it never fires', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    const callback = vi.fn();
    room.disconnectTimers['dev-1'] = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_2'] = room;

    deleteRoom('DELETE_ROOM_TEST_2');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels multiple pending disconnectTimers entries', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    room.disconnectTimers['dev-1'] = setTimeout(cb1, 1000);
    room.disconnectTimers['dev-2'] = setTimeout(cb2, 1000);
    rooms['DELETE_ROOM_TEST_3'] = room;

    deleteRoom('DELETE_ROOM_TEST_3');
    vi.advanceTimersByTime(5000);

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('cancels a pending turnExpireTimer', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    const callback = vi.fn();
    room.turnExpireTimer = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_4'] = room;

    deleteRoom('DELETE_ROOM_TEST_4');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });

  // Both registries are keyed by client-supplied strings (joinRoom validates
  // roomId and deviceId only as non-empty strings within a length bound), so
  // an id naming an Object.prototype member must not resolve to an inherited
  // value: '__proto__' as a deviceId used to be swallowed by the prototype
  // setter, leaving a timer nothing could see — or cancel.
  it('cancels a disconnect timer whose deviceId names an Object.prototype member', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    const callback = vi.fn();
    room.disconnectTimers['__proto__'] = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_5'] = room;

    expect(Object.keys(room.disconnectTimers)).toEqual(['__proto__']);
    deleteRoom('DELETE_ROOM_TEST_5');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });
});

describe('the room registry', () => {
  it('resolves an id naming an Object.prototype member to nothing, not to the inherited value', () => {
    // `!rooms[roomId]` is joinRoom's "does this room exist" test and
    // `rooms[roomId]` is what it then works with. On a plain object literal
    // both answer with Object.prototype's own members for these ids, so the
    // room was never created and the handler threw on the inherited value —
    // an ack that never fires for the caller.
    expect(rooms['__proto__']).toBeUndefined();
    expect(rooms['constructor']).toBeUndefined();
    expect(rooms['toString']).toBeUndefined();
    expect(rooms['hasOwnProperty']).toBeUndefined();
  });

  it('stores a room under such an id as a real, enumerable entry', () => {
    rooms['__proto__'] = createRoom('sock-proto-host');

    expect(rooms['__proto__']).toBeDefined();
    expect(Object.keys(rooms)).toContain('__proto__');

    deleteRoom('__proto__');
    expect(rooms['__proto__']).toBeUndefined();
  });
});
