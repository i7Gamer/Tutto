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
import { handleActivePlayerRemoved, calculateRemainingTurnTime, createRoom } from './rooms';
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
        round: 4,
        cards: ['200', '300'],
        currentCard: 'Kniffel',
        liveTurnState: { turnScore: 20, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });

      handleActivePlayerRemoved(room, 0);

      expect(room.state.currentPlayerIndex).toBe(0); // now points at Bob, shifted into Alice's slot
      expect(room.state.round).toBe(4); // unchanged — not the last player in the order
      expect(room.state.previousCard).toBeNull();
      expect(room.state.previousScore).toBeNull();
      expect(room.state.previousLeaders).toBeNull();
      expect(room.state.liveTurnState).toBeNull();
      expect(room.state.turnStartTime).toBe(Date.now());
      // A new card was drawn for the player now occupying the active slot.
      expect(room.state.cards).toEqual(['300']);
      expect(room.state.currentCard).toBe('200');
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

      handleActivePlayerRemoved(room, 2);

      expect(room.state.currentPlayerIndex).toBe(0);
      expect(room.state.round).toBe(8); // advanced — the removed player was last to act this round
      expect(room.state.previousCard).toBeNull();
      expect(room.state.turnStartTime).toBe(Date.now());
      expect(room.state.currentCard).toBe('Stop');
      expect(room.state.cards).toEqual([]);
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
