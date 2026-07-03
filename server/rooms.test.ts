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
const makeState = (playersAfterSplice: string[], overrides: Partial<RoomState> = {}): RoomState => {
  const state = createRoom('sock-host').state;
  state.players = playersAfterSplice.map(n => makePlayer(n));
  state.chartValues = playersAfterSplice.map(() => [100]);
  state.chartNames = [...playersAfterSplice];
  Object.assign(state, overrides);
  return state;
};

describe('handleActivePlayerRemoved', () => {
  describe('chart array shrinking', () => {
    it('splices the removed index out of chartValues and chartNames', () => {
      // Original roster [Alice, Bob, Carol], Bob (idx 1) removed. players is
      // already post-splice ([Alice, Carol]); chartValues/chartNames still
      // hold all 3 entries, mirroring the caller's actual sequencing.
      const state = makeState(['Alice', 'Carol'], { currentPlayerIndex: null });
      state.chartValues = [[100], [200], [300]];
      state.chartNames = ['Alice', 'Bob', 'Carol'];
      handleActivePlayerRemoved(state, 1);
      expect(state.chartValues).toEqual([[100], [300]]);
      expect(state.chartNames).toEqual(['Alice', 'Carol']);
    });

    it('leaves chart arrays untouched when removedIdx is out of bounds', () => {
      const state = makeState(['Alice'], { currentPlayerIndex: null });
      state.chartValues = [[100]];
      state.chartNames = ['Alice'];
      handleActivePlayerRemoved(state, 5);
      expect(state.chartValues).toEqual([[100]]);
      expect(state.chartNames).toEqual(['Alice']);
    });

    it('does not throw when chartValues/chartNames are not arrays', () => {
      const state = makeState(['Alice'], { currentPlayerIndex: null });
      (state as unknown as { chartValues: unknown }).chartValues = undefined;
      (state as unknown as { chartNames: unknown }).chartNames = undefined;
      expect(() => handleActivePlayerRemoved(state, 0)).not.toThrow();
    });
  });

  describe('no active game (currentPlayerIndex === null)', () => {
    it('returns without touching turn-order fields', () => {
      const state = makeState(['Alice', 'Bob'], {
        currentPlayerIndex: null,
        previousCard: 'Stop',
        turnStartTime: null,
      });
      handleActivePlayerRemoved(state, 0);
      expect(state.currentPlayerIndex).toBeNull();
      expect(state.previousCard).toBe('Stop');
      expect(state.turnStartTime).toBeNull();
    });
  });

  describe('removed player was before the active player (removedIdx < curIdx)', () => {
    it('shifts currentPlayerIndex down by one and changes nothing else', () => {
      // Original [Alice, Bob, Carol], Carol (idx 2) was active; Alice (idx 0) removed.
      const state = makeState(['Bob', 'Carol'], {
        currentPlayerIndex: 2,
        previousCard: 'x2',
        previousScore: 300,
        currentCard: 'Stop',
        cards: ['200'],
        round: 3,
        turnStartTime: 12345,
        liveTurnState: { turnScore: 50, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });
      handleActivePlayerRemoved(state, 0);
      expect(state.currentPlayerIndex).toBe(1);
      // No mid-turn reset — the active player themselves wasn't touched.
      expect(state.previousCard).toBe('x2');
      expect(state.previousScore).toBe(300);
      expect(state.currentCard).toBe('Stop');
      expect(state.cards).toEqual(['200']);
      expect(state.round).toBe(3);
      expect(state.turnStartTime).toBe(12345);
      expect(state.liveTurnState).not.toBeNull();
    });
  });

  describe('removed player was after the active player (removedIdx > curIdx)', () => {
    it('leaves currentPlayerIndex and turn state completely unchanged', () => {
      // Original [Alice, Bob, Carol], Alice (idx 0) active; Carol (idx 2) removed.
      const state = makeState(['Alice', 'Bob'], {
        currentPlayerIndex: 0,
        previousCard: 'Kniffel',
        currentCard: '500',
        cards: ['600'],
        round: 5,
        turnStartTime: 99999,
      });
      handleActivePlayerRemoved(state, 2);
      expect(state.currentPlayerIndex).toBe(0);
      expect(state.previousCard).toBe('Kniffel');
      expect(state.currentCard).toBe('500');
      expect(state.cards).toEqual(['600']);
      expect(state.round).toBe(5);
      expect(state.turnStartTime).toBe(99999);
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
      const state = makeState(['Bob', 'Carol'], {
        currentPlayerIndex: 0,
        previousCard: 'Kniffel',
        previousScore: 2000,
        previousLeaders: [{ name: 'Bob', score: 10 } as unknown as ServerPlayer],
        round: 4,
        cards: ['200', '300'],
        currentCard: 'Kniffel',
        liveTurnState: { turnScore: 20, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });

      handleActivePlayerRemoved(state, 0);

      expect(state.currentPlayerIndex).toBe(0); // now points at Bob, shifted into Alice's slot
      expect(state.round).toBe(4); // unchanged — not the last player in the order
      expect(state.previousCard).toBeNull();
      expect(state.previousScore).toBeNull();
      expect(state.previousLeaders).toBeNull();
      expect(state.liveTurnState).toBeNull();
      expect(state.turnStartTime).toBe(Date.now());
      // A new card was drawn for the player now occupying the active slot.
      expect(state.cards).toEqual(['300']);
      expect(state.currentCard).toBe('200');
    });

    it('last in order: index wraps to 0 and the round advances', () => {
      // Original [Alice, Bob, Carol], Carol (idx 2) active and removed.
      // Post-splice players = [Alice, Bob], length 2. removedIdx(2) === length(2) -> last.
      const state = makeState(['Alice', 'Bob'], {
        currentPlayerIndex: 2,
        previousCard: 'x2',
        previousScore: 400,
        round: 7,
        cards: ['Stop'],
        currentCard: 'x2',
      });

      handleActivePlayerRemoved(state, 2);

      expect(state.currentPlayerIndex).toBe(0);
      expect(state.round).toBe(8); // advanced — the removed player was last to act this round
      expect(state.previousCard).toBeNull();
      expect(state.turnStartTime).toBe(Date.now());
      expect(state.currentCard).toBe('Stop');
      expect(state.cards).toEqual([]);
    });

    it('draws from a freshly built deck when the pre-existing deck is exhausted', () => {
      const state = makeState(['Alice'], {
        currentPlayerIndex: 1,
        cards: [], // exhausted
        currentCard: 'Stop',
        initialCards: { Stop: 2 },
      });

      handleActivePlayerRemoved(state, 1);

      // buildDeck({Stop: 2}) was used to refill — both cards are 'Stop', so
      // the draw is deterministic: one drawn as currentCard, one left in cards.
      expect(state.currentCard).toBe('Stop');
      expect(state.cards).toEqual(['Stop']);
    });

    it('last player removed leaves zero players: currentPlayerIndex still resolves to 0, round still advances', () => {
      // Single-player edge case: players=[Alice], Alice (idx 0) active and removed.
      // Post-splice players = [], length 0. removedIdx(0) === length(0) -> last.
      const state = makeState([], {
        currentPlayerIndex: 0,
        round: 1,
        cards: ['200'],
        currentCard: 'Stop',
      });

      expect(() => handleActivePlayerRemoved(state, 0)).not.toThrow();
      expect(state.currentPlayerIndex).toBe(0); // 0 % max(1, 0) === 0 % 1 === 0
      expect(state.round).toBe(2);
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

  const makeRoom = (stateOverrides: Partial<RoomState>): Room => {
    const room = createRoom('sock-host');
    Object.assign(room.state, stateOverrides);
    return room;
  };

  it('returns null when no turn is in progress (turnStartTime is null)', () => {
    const room = makeRoom({ turnStartTime: null, turnDuration: 120 });
    expect(calculateRemainingTurnTime(room)).toBeNull();
  });

  it('returns null when the timer is disabled (turnDuration === 0), even mid-turn', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 0 });
    expect(calculateRemainingTurnTime(room)).toBeNull();
  });

  it('returns the full duration right when a turn starts', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 120, currentCard: null });
    expect(calculateRemainingTurnTime(room)).toBe(120);
  });

  it('counts down as time elapses', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 120, currentCard: null });
    vi.advanceTimersByTime(30_000);
    expect(calculateRemainingTurnTime(room)).toBe(90);
  });

  it('never goes negative once the duration has fully elapsed', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 10, currentCard: null });
    vi.advanceTimersByTime(60_000);
    expect(calculateRemainingTurnTime(room)).toBe(0);
  });

  it('applies the Feuerwerk 3x multiplier', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Feuerwerk' });
    expect(calculateRemainingTurnTime(room)).toBe(300);
    vi.advanceTimersByTime(50_000);
    expect(calculateRemainingTurnTime(room)).toBe(250);
  });

  it('applies the Kleeblatt 2x multiplier', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Kleeblatt' });
    expect(calculateRemainingTurnTime(room)).toBe(200);
  });

  it('applies no multiplier for a card with no configured multiplier', () => {
    const room = makeRoom({ turnStartTime: Date.now(), turnDuration: 100, currentCard: 'Stop' });
    expect(calculateRemainingTurnTime(room)).toBe(100);
  });
});
