/**
 * @vitest-environment node
 *
 * In-process unit tests for the pure room-state helpers in rooms.ts. The socket
 * suites prove the same behavior holds over the wire via
 * kick/leave/disconnect-timeout; these pin the trickiest branches — turn-order
 * bookkeeping on active-player removal, the turn-timer countdown formula, and
 * the abandoned-room predicate — directly and cheaply.
 *
 * Coverage is part of the point for the ones that remain spawned: a subprocess
 * is invisible to the instrumentation. That argument no longer covers
 * turnTimer.test.ts, which now runs in-process itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BROADCAST_EXCLUDED_FIELDS, handleActivePlayerRemoved, calculateRemainingTurnTime, createRoom, deleteRoom, emitRoomState, isAbandonedRoom, promoteHostAfterLoss, rooms } from './rooms';
import type { Server } from 'socket.io';
import { SYNCED_GAME_STATE_KEYS } from '../src/types';
import { MAX_ROUNDS } from './pushValidation';
import type { Room, RoomState, ServerPlayer } from './roomTypes';
import { makeServerPlayer as makePlayer } from './socketTestHarness';
import { nonNull } from '../src/testing/factories';

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
      room.turnTimerState = { lastCard: 'Stop', lastPlayerIndex: 2, lastDeckSize: null, restartsThisTurn: 0 };
      handleActivePlayerRemoved(room, 0);
      const timerState = nonNull(room.turnTimerState);
      expect(timerState.lastPlayerIndex).toBe(1);
      expect(timerState.lastCard).toBe('Stop');
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

    it('stops appending chart datapoints once the MAX_ROUNDS cap is reached', () => {
      // The same bound turnTimers.advanceTurnOnTimeout respects on its own
      // round-end append. Not an abuse story here — it takes a real seat
      // removal per datapoint — but the cap is what pushValidation ENFORCES on
      // the way in: a chartLabels longer than MAX_ROUNDS is refused wholesale,
      // so a server array that grew past it is one no client can ever push
      // back, and the two copies silently diverge from there.
      const fullSeries = () => Array(MAX_ROUNDS).fill(0);
      const room = makeRoom(['Alice', 'Bob'], {
        currentPlayerIndex: 2,
        round: 7,
        cards: ['Stop'],
        currentCard: 'x2',
        chartValues: [fullSeries(), fullSeries(), fullSeries()],
        chartNames: ['Alice', 'Bob', 'Carol'],
        chartLabels: fullSeries(),
      });

      handleActivePlayerRemoved(room, 2);

      expect(room.state.chartLabels).toHaveLength(MAX_ROUNDS);
      expect(room.state.chartValues[0]).toHaveLength(MAX_ROUNDS);
      // The turn bookkeeping itself still runs — only the chart append stops.
      expect(room.state.currentPlayerIndex).toBe(0);
      expect(room.state.round).toBe(8);
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
      room.turnTimerState = { lastCard: 'Kniffel', lastPlayerIndex: 0, lastDeckSize: null, restartsThisTurn: 0 };

      handleActivePlayerRemoved(room, 0);

      const timerState = nonNull(room.turnTimerState);
      expect(timerState.lastCard).toBe(room.state.currentCard);
      expect(timerState.lastCard).toBe('200');
      expect(timerState.lastPlayerIndex).toBe(0);
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
    // Annotated: passed straight into setTimeout below, and a bare Mock's
    // inferred type doesn't match Node's setTimeout overload closely enough,
    // so TS falls back to lib.dom's — whose return type is `number`, not
    // the `NodeJS.Timeout` disconnectTimers/turnExpireTimer declare.
    const callback: () => void = vi.fn();
    room.disconnectTimers['dev-1'] = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_2'] = room;

    deleteRoom('DELETE_ROOM_TEST_2');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels multiple pending disconnectTimers entries', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    const cb1: () => void = vi.fn();
    const cb2: () => void = vi.fn();
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
    // Annotated: passed straight into setTimeout below, and a bare Mock's
    // inferred type doesn't match Node's setTimeout overload closely enough,
    // so TS falls back to lib.dom's — whose return type is `number`, not
    // the `NodeJS.Timeout` disconnectTimers/turnExpireTimer declare.
    const callback: () => void = vi.fn();
    room.turnExpireTimer = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_4'] = room;

    deleteRoom('DELETE_ROOM_TEST_4');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });

  // Both registries are keyed by client-supplied strings (joinRoom validates
describe('emitRoomState scrubs reconnect credentials', () => {
  // deviceId is a reconnect credential: possession of one is enough to take
  // over that player's seat (see joinRoom). It must never leave the server
  // except back to its own owner, and previousLeaders is the easy one to
  // forget -- it is a snapshot of FULL player objects, taken before the turn
  // that moved the lead, and it rides every broadcast until the next turn
  // overwrites it.
  //
  // The scrub is applied (this is not a live leak); what it did not have was
  // anything that fails if it is deleted.
  const captureBroadcast = () => {
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) } as unknown as Server;
    return { io, emit };
  };

  const stateOf = (emit: ReturnType<typeof vi.fn>): Record<string, unknown> => {
    const call = emit.mock.calls.find(([event]) => event === 'gameState');
    expect(call, 'no gameState was broadcast at all').toBeDefined();
    return call![1] as Record<string, unknown>;
  };

  afterEach(() => {
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  it('strips deviceId from the roster and from previousLeaders alike', () => {
    const room = createRoom('sock-host');
    rooms['SCRUB_ROOM'] = room;
    room.state.players = [makePlayer('Alice'), makePlayer('Bob')];
    room.state.previousLeaders = [makePlayer('Alice')];

    const { io, emit } = captureBroadcast();
    emitRoomState(io, 'SCRUB_ROOM');

    const state = stateOf(emit);
    const players = state.players as Record<string, unknown>[];
    const leaders = state.previousLeaders as Record<string, unknown>[];

    expect(players.map(p => p.name)).toEqual(['Alice', 'Bob']);
    expect(players.every(p => !('deviceId' in p)), 'a roster deviceId went out over the wire').toBe(true);
    expect(leaders.map(p => p.name)).toEqual(['Alice']);
    expect(leaders.every(p => !('deviceId' in p)), 'a previousLeaders deviceId went out over the wire').toBe(true);
  });

  it('leaves a null previousLeaders alone rather than mapping over it', () => {
    // The common case by far -- every broadcast before the first lead change
    // -- and `null.map` would take the whole room down.
    const room = createRoom('sock-host');
    rooms['SCRUB_NULL_ROOM'] = room;
    room.state.players = [makePlayer('Alice')];
    room.state.previousLeaders = null;

    const { io, emit } = captureBroadcast();
    emitRoomState(io, 'SCRUB_NULL_ROOM');

    expect(stateOf(emit).previousLeaders).toBeNull();
  });

  it('carries every canonical synced field on the wire', () => {
    // The broadcast payload is the one list SYNCED_GAME_STATE_KEYS did not
    // lock: six others (PushFieldLock, the FIELD_HANDLERS satisfies,
    // RoomStateFieldLock, ClearRoomStateLock, LocalSaveFieldLock, the client's
    // push payload) fail the build when a field goes missing, while dropping
    // one from the object that actually goes out type-checked clean. The
    // compile-time twin is BroadcastFieldLock in rooms.ts; this is its runtime
    // half, and it also catches a field emitted as `undefined`.
    const room = createRoom('sock-host');
    rooms['WIRE_COMPLETE_ROOM'] = room;
    room.state.players = [makePlayer('Alice')];

    const { io, emit } = captureBroadcast();
    emitRoomState(io, 'WIRE_COMPLETE_ROOM');

    const state = stateOf(emit);
    // Minus whatever the payload deliberately withholds — the same list the
    // compile-time lock reads, so the two can never disagree about what is
    // supposed to be on the wire. previousWasSuccess is the one optional
    // synced field (a turn predating it records none — see RoomState), so
    // presence of the KEY is the rule here, not a defined value.
    const excluded = BROADCAST_EXCLUDED_FIELDS as readonly string[];
    const missing = SYNCED_GAME_STATE_KEYS
      .filter(key => !excluded.includes(key))
      .filter(key => !(key in state));
    expect(missing, 'a synced field never reached the clients').toEqual([]);
  });
});

  // roomId and deviceId only as non-empty strings within a length bound), so
  // an id naming an Object.prototype member must not resolve to an inherited
  // value: '__proto__' as a deviceId used to be swallowed by the prototype
  // setter, leaving a timer nothing could see — or cancel.
  it('cancels a disconnect timer whose deviceId names an Object.prototype member', () => {
    vi.useFakeTimers();
    const room = createRoom('sock-host');
    // Annotated: passed straight into setTimeout below, and a bare Mock's
    // inferred type doesn't match Node's setTimeout overload closely enough,
    // so TS falls back to lib.dom's — whose return type is `number`, not
    // the `NodeJS.Timeout` disconnectTimers/turnExpireTimer declare.
    const callback: () => void = vi.fn();
    room.disconnectTimers['__proto__'] = setTimeout(callback, 1000);
    rooms['DELETE_ROOM_TEST_5'] = room;

    expect(Object.keys(room.disconnectTimers)).toEqual(['__proto__']);
    deleteRoom('DELETE_ROOM_TEST_5');
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });
});

/**
 * The failover that keeps a room manageable: `pushState`'s host branch,
 * `updateConfig`, `kickPlayer` and `submitGlobalStats` all gate on
 * `room.host === socket.id`, so a host id pointing at a socket nobody holds
 * makes the room unmanageable until it dies.
 *
 * It had no test of its own at all, which is how `?? room.state.players[0]`
 * survived: reached from the reconnect-timer drain, that fallback hands the
 * room straight to a DISCONNECTED seat — the very state the function exists
 * to get out of.
 */
describe('promoteHostAfterLoss', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const id of Object.keys(rooms)) deleteRoom(id);
  });

  const roomHostedBy = (hostSocketId: string, players: ServerPlayer[]): Room => {
    const room = createRoom(hostSocketId);
    room.state.players = players;
    return room;
  };

  it('hands a room whose host seat is gone to a connected player', () => {
    // What the reconnect-timer drain leaves behind: the host's seat has just
    // been spliced out, so nothing holds room.host any more.
    const room = roomHostedBy('sock-Gone', [
      makePlayer('Bob', { socketId: 'sock-Bob', disconnected: true }),
      makePlayer('Carol', { socketId: 'sock-Carol' }),
    ]);

    expect(promoteHostAfterLoss(room)).toBe(true);
    expect(room.host).toBe('sock-Carol');
  });

  it('never hands the room to a disconnected seat', () => {
    // The `?? players[0]` fallback did exactly this: the room came back owned
    // by a socket that is not there, so nobody could change config, kick the
    // ghost, restart or submit the game's statistics — and no timer was left
    // to try again.
    const room = roomHostedBy('sock-Gone', [
      makePlayer('Bob', { socketId: 'sock-Bob', disconnected: true }),
      makePlayer('Carol', { socketId: 'sock-Carol', disconnected: true }),
    ]);

    expect(promoteHostAfterLoss(room)).toBe(false);
    expect(room.host, 'the room was handed to a dead socket').toBe('sock-Gone');
  });

  it('leaves a room alone while a connected seat still holds it', () => {
    const room = roomHostedBy('sock-Alice', [
      makePlayer('Alice', { socketId: 'sock-Alice' }),
      makePlayer('Bob', { socketId: 'sock-Bob' }),
    ]);

    expect(promoteHostAfterLoss(room)).toBe(false);
    expect(room.host).toBe('sock-Alice');
  });

  it('does not steal the room from a host who merely blinked', () => {
    // A host who dropped with a reconnect window still pending keeps the room
    // for that window — the deliberate policy socketRoomHandlers documents on
    // its disconnect path, where only reconnectTimeout === 0 (which arms no
    // timer at all, so nothing would ever recover the room) promotes early.
    vi.useFakeTimers();
    const room = roomHostedBy('sock-Alice', [
      makePlayer('Alice', { socketId: 'sock-Alice', disconnected: true }),
      makePlayer('Bob', { socketId: 'sock-Bob' }),
    ]);
    room.disconnectTimers['dev-Alice'] = setTimeout(() => {}, 60_000);

    expect(promoteHostAfterLoss(room)).toBe(false);
    expect(room.host).toBe('sock-Alice');
  });

  it('promotes a host who dropped with no reconnect window to come back in', () => {
    // reconnectTimeout === 0: the seat is marked disconnected and no timer is
    // armed, so nothing would ever revisit the room.
    const room = roomHostedBy('sock-Alice', [
      makePlayer('Alice', { socketId: 'sock-Alice', disconnected: true }),
      makePlayer('Bob', { socketId: 'sock-Bob' }),
    ]);

    expect(promoteHostAfterLoss(room)).toBe(true);
    expect(room.host).toBe('sock-Bob');
  });

  it('reports false for an empty roster rather than throwing', () => {
    expect(promoteHostAfterLoss(roomHostedBy('sock-Gone', []))).toBe(false);
  });
});

/**
 * The predicate three separate paths delete a room on — an explicit leave, a
 * kick, and a draining reconnect timer — so its branches are worth pinning
 * once here rather than only where each caller happens to exercise them.
 */
describe('isAbandonedRoom', () => {
  // The pending-timer case below switches to fake timers; without this they
  // stay switched on for every test after it in the file. Same pairing the
  // three describes above already use.
  afterEach(() => {
    vi.useRealTimers();
  });

  const roomWith = (players: ServerPlayer[]): Room => {
    const room = createRoom('sock-host');
    room.state.players = players;
    return room;
  };

  it('is true when every remaining seat is disconnected and no timer is pending', () => {
    // The case all three callers exist to catch: nothing left to disconnect and
    // nothing scheduled to revisit the room, so it would survive until restart.
    expect(isAbandonedRoom(roomWith([
      makePlayer('Alice', { disconnected: true }),
      makePlayer('Bob', { disconnected: true }),
    ]))).toBe(true);
  });

  it('is false while any seat is still connected', () => {
    expect(isAbandonedRoom(roomWith([
      makePlayer('Alice', { disconnected: true }),
      makePlayer('Bob', { disconnected: false }),
    ]))).toBe(false);
  });

  it('is false while a reconnect timer is still pending', () => {
    // Every seat is a ghost, but one of them is owed a reconnect window — the
    // timer will revisit the room, so it is not abandoned yet. Dropping this
    // half of the predicate would delete rooms out from under reconnecting
    // players.
    vi.useFakeTimers();
    const room = roomWith([
      makePlayer('Alice', { disconnected: true }),
      makePlayer('Bob', { disconnected: true }),
    ]);
    room.disconnectTimers['dev-Alice'] = setTimeout(() => {}, 1000);

    expect(isAbandonedRoom(room)).toBe(false);
  });

  it('is true for an empty roster', () => {
    // Never observed through the callers, which all short-circuit on
    // `players.length === 0` before reaching this — but the doc comment leans
    // on the pairing, so the behaviour under it is worth stating.
    expect(isAbandonedRoom(roomWith([]))).toBe(true);
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
