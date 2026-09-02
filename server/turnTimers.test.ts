/**
 * @vitest-environment node
 *
 * In-process unit tests for the server-authoritative turn timer in
 * turnTimers.ts. turnTimer.test.ts (spawned subprocess) proves the same
 * behavior end-to-end over a real socket, but the subprocess boundary means
 * none of that file's coverage shows up here — these tests exercise the
 * exported functions directly against the shared `rooms` registry with a
 * stub `io`, and they can reach branches E2E structurally cannot: a
 * corrupted room state that pushState's own validation should make
 * unreachable in production (the try/catch backstop in advanceTurnOnTimeout).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rooms, createRoom, roomChannel } from './rooms';
import { clearServerTurnTimer, startServerTurnTimer, advanceTurnOnTimeout, abortGameIfLowPlayers, scaledTimerMs } from './turnTimers';
import { makeServerPlayer as makePlayer, makeFakeIo } from './socketTestHarness';

const roomId = 'timer-unit-room';

// vite.config.ts sets TEST_TIMER_SCALE for the whole suite to accelerate the
// spawned-server integration tests, and startServerTurnTimer applies it here
// too — so a turn nominally lasting N seconds is armed for N * scale. Tests that
// advance the fake clock must scale with it, mirroring turnTimers.ts exactly:
// advancing a raw, unscaled duration overshoots the real deadline and lets the
// timer re-arm and fire repeatedly instead of not firing at all.
const TIMER_SCALE = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
const scaledTimeoutMs = (seconds: number) => Math.max(10, Math.floor(seconds * 1000 * TIMER_SCALE));

describe('turnTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    delete rooms[roomId];
  });

  afterEach(() => {
    vi.useRealTimers();
    delete rooms[roomId];
  });

  describe('clearServerTurnTimer', () => {
    it('does nothing when the room does not exist', () => {
      expect(() => clearServerTurnTimer(roomId)).not.toThrow();
    });

    it('does nothing when the room has no pending timer', () => {
      rooms[roomId] = createRoom('host-1');
      expect(() => clearServerTurnTimer(roomId)).not.toThrow();
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('clears a pending timer', () => {
      rooms[roomId] = createRoom('host-1');
      rooms[roomId].turnExpireTimer = setTimeout(() => {}, 10000);
      clearServerTurnTimer(roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });
  });

  describe('startServerTurnTimer', () => {
    it('does nothing when the room does not exist', () => {
      const { io } = makeFakeIo();
      expect(() => startServerTurnTimer(io, roomId)).not.toThrow();
    });

    it('does not schedule when status is not playing', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', currentPlayerIndex: 0, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when the game is finished', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', finished: true, currentPlayerIndex: 0, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when currentPlayerIndex is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: null, turnDuration: 60, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when turnDuration is 0', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: 0, turnDuration: 0, turnStartTime: Date.now() });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('does not schedule when turnStartTime is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: 0, turnDuration: 60, turnStartTime: null });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).toBeNull();
    });

    it('schedules a timeout for the remaining duration and does not fire early', () => {
      const TURN_DURATION_SECONDS = 30;
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: TURN_DURATION_SECONDS, turnStartTime: Date.now(),
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).not.toBeNull();

      // Straddle the deadline rather than picking a value inside the turn: one
      // tick short must not fire, and the very next tick must. Asserting only
      // the "before" half is what made this fragile — with the scaled deadline
      // the old 29s advance fired the timer four times (6s, 12s, 18s, 24s), and
      // the assertion still held purely because two players and an even number
      // of advances cycled currentPlayerIndex back to 0.
      const deadlineMs = scaledTimeoutMs(TURN_DURATION_SECONDS);
      vi.advanceTimersByTime(deadlineMs - 1);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(0); // not advanced yet

      vi.advanceTimersByTime(1);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(1); // fires exactly on the deadline
    });

    it('re-arming clears the previous timer first (safe to call repeatedly)', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: 30, turnStartTime: Date.now(),
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      const firstTimer = rooms[roomId].turnExpireTimer;
      startServerTurnTimer(makeFakeIo().io, roomId);
      expect(rooms[roomId].turnExpireTimer).not.toBe(firstTimer);
    });

    // Disabling the turn timer mid-game (updateConfig -> turnDuration 0) goes
    // through this same re-arm — socketConfigHandlers calls it unconditionally
    // and relies on the guards here. The "does not schedule when turnDuration
    // is 0" test above only covers arming from nothing; this covers the case
    // that actually happens, where a timer is already ticking on a live turn.
    it('cancels a live turn timer when the duration is disabled mid-turn', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: 30, turnStartTime: Date.now(),
        players: [makePlayer('Alice'), makePlayer('Bob')],
        currentCard: '200', cards: ['300'],
      });
      const { io } = makeFakeIo();
      startServerTurnTimer(io, roomId);
      expect(rooms[roomId].turnExpireTimer, 'a timer must be running to cancel').toBeDefined();

      rooms[roomId].state.turnDuration = 0;
      startServerTurnTimer(io, roomId);

      // null, not undefined: clearServerTurnTimer nulls the handle so the
      // module's own "is a timer running" bookkeeping cannot lie.
      expect(rooms[roomId].turnExpireTimer).toBeNull();
      // And the turn it was armed for is not advanced by the cancellation —
      // disabling the clock must not cost the current player their turn.
      vi.advanceTimersByTime(60_000);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(0);
    });

    it('advances immediately (synchronously) when the remaining time is already <= 0', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, turnDuration: 10,
        turnStartTime: Date.now() - 20_000, // already expired
        players: [makePlayer('Alice'), makePlayer('Bob')],
        currentCard: '200', cards: ['300'],
      });
      startServerTurnTimer(makeFakeIo().io, roomId);
      // advanceTurnOnTimeout ran synchronously — the turn has already moved on,
      // and no timer is left pending for the expired turn.
      expect(rooms[roomId].state.currentPlayerIndex).toBe(1);
    });
  });

  describe('advanceTurnOnTimeout', () => {
    it('does nothing when the room no longer exists (deleted mid-flight)', () => {
      const { io, emit } = makeFakeIo();
      expect(() => advanceTurnOnTimeout(io, roomId)).not.toThrow();
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when the game is already finished', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', finished: true, currentPlayerIndex: 0 });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when status is not playing', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', currentPlayerIndex: 0 });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing when currentPlayerIndex is null', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', currentPlayerIndex: null });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);
      expect(emit).not.toHaveBeenCalled();
    });

    it('treats the timeout as a bust (no manual action taken) and advances to the next player', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      const { io, emit } = makeFakeIo();
      advanceTurnOnTimeout(io, roomId);

      const state = rooms[roomId].state;
      expect(state.currentPlayerIndex).toBe(1);
      expect(state.players[0].busts).toBe(1);
      expect(state.previousCard).toBe('200');
      expect(state.previousScore).toBe(0);
      expect(emit).toHaveBeenCalledWith('gameState', expect.any(Object));
      expect(emit).toHaveBeenCalledWith('hostId', 'host-1');
    });

    it('schedules the next turn timer via the recursive re-arm when the game continues', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, turnDuration: 45,
        players: [makePlayer('Alice'), makePlayer('Bob')],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);
      // The just-advanced turn (now player 1) has its own fresh expiry armed.
      expect(rooms[roomId].turnExpireTimer).not.toBeNull();
      expect(rooms[roomId].turnTimerState?.lastPlayerIndex).toBe(1);
    });

    it('finishes the game and clears gameActualStartTime when the timeout ends the game', () => {
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      room.gameActualStartTime = Date.now() - 5000;
      Object.assign(room.state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: [],
        round: 1, winningScore: 100,
        players: [{ ...makePlayer('Alice'), score: 100 }],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(room.state.finished).toBe(true);
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.currentCard).toBeNull();
      expect(room.state.turnStartTime).toBeNull();
      expect(room.gameActualStartTime).toBeNull();
      expect(room.state.gameTimeInSeconds).toBeGreaterThanOrEqual(5);
      expect(room.turnExpireTimer).toBeNull(); // no further timer scheduled once over
    });

    it('pushes a chart datapoint when the timeout ends the round', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 1, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        chartValues: [[0], [0]], chartLabels: [],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.chartValues[0].length).toBe(2);
      expect(rooms[roomId].state.chartValues[1].length).toBe(2);
      expect(rooms[roomId].state.chartLabels).toEqual([1]);
      expect(rooms[roomId].state.round).toBe(2);
    });

    it('skips the round-end datapoint when the chart series are out of step with the roster', () => {
      // chartLabels is round-indexed and chartValues is player-indexed, so a
      // label may only be appended when the series it labels were appended
      // too. handleActivePlayerRemoved gates its identical round-end
      // bookkeeping this way; this path did not, so a roster/series mismatch
      // grew chartLabels past every series and skewed the end-screen chart.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 1, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        chartValues: [], chartLabels: [],
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.chartLabels).toEqual([]);
      // The turn itself still advances — only the chart bookkeeping is skipped.
      expect(rooms[roomId].state.round).toBe(2);
      expect(rooms[roomId].state.currentPlayerIndex).toBe(0);
    });

    it('reconstructs a classic chain forfeit from the live snapshot, counting every chain card', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 1800, keptDice: [],
          // A genuinely unresolved roll: the tab died mid-roll, so the dice
          // sit on the table with no verdict — the one state the timeout
          // still reads as the dice null. (An EMPTY flagless table is the
          // drawn-card reveal, classified as its own case below.)
          currentRoll: [{ id: 'r1', val: 2, selected: false }, { id: 'r2', val: 3, selected: false }],
          kniffelProgress: [],
          tuttosThisTurn: 2,
          cardsThisTurn: ['500', 'Kniffel', 'Feuerwerk'],
          plusMinusScores: [],
          chainTuttoCount: 2,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      const alice = state.players[0];
      expect(state.currentPlayerIndex).toBe(1);
      expect(alice.busts).toBe(1);
      expect(alice.timesKniffelCompleted).toBe(1);   // completed mid-chain
      expect(alice.timesFeuerwerkReceived).toBe(1);  // the card the chain died on
      expect(alice.totalTuttos).toBe(2);
      expect(alice.mostCardsInTurn).toBe(3);
      expect(alice.highestForfeitedTurnScore).toBe(1800);
      expect(state.previousScore).toBe(0);
      expect(state.previousTurnSummary?.cards.map(c => c.card)).toEqual(['500', 'Kniffel', 'Feuerwerk']);
      const lastEntry = state.historyLog[state.historyLog.length - 1];
      expect(lastEntry.type).toBe('bust');
      expect(lastEntry.cards).toEqual(['500', 'Kniffel', 'Feuerwerk']);
    });

    it('stops appending chart datapoints once the MAX_ROUNDS cap is reached', () => {
      // The timeout path can self-advance forever when no one ever reaches the
      // winning score (e.g. a patched host arming a 1s turn in an idle room).
      // Pushed chart arrays are capped at MAX_ROUNDS — the server's own
      // appends must respect the same bound or state grows without limit.
      rooms[roomId] = createRoom('host-1');
      const fullSeries = Array(100000).fill(0);
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 1, currentCard: '300', cards: ['200'],
        round: 100001, players: [makePlayer('Alice'), makePlayer('Bob')],
        chartValues: [fullSeries, [...fullSeries]], chartLabels: Array(100000).fill(1),
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.chartLabels).toHaveLength(100000);
      expect(rooms[roomId].state.chartValues[0]).toHaveLength(100000);
      // The turn itself still advances — only the chart bookkeeping stops.
      expect(rooms[roomId].state.round).toBe(100002);
    });

    it('does not invent a bust when the timeout lands on the bank-or-draw choice', () => {
      // The choice state is exactly where an AFK classic player parks (it has
      // deliberately no client countdown): all six dice are put aside and the
      // card is COMPLETED. The forfeit stands — but no null was ever rolled,
      // so no bust, and the completed straight counts as completed.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 2000,
          keptDice: [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v })),
          currentRoll: [], kniffelProgress: [1, 2, 3, 4, 5, 6], tuttosThisTurn: 1,
          cardsThisTurn: ['Kniffel'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesKniffelCompleted).toBe(1);
      expect(alice.timesKniffelFailed).toBe(0);
      // Still a forfeit: nothing banks, and the thrown-away total is recorded.
      expect(rooms[roomId].state.previousScore).toBe(0);
      expect(alice.highestForfeitedTurnScore).toBe(2000);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([{ card: 'Kniffel', completed: true }]);
    });

    it('does not invent a bust at the bank-or-draw choice while the completing dice are still selected', () => {
      // The shape the client ACTUALLY emits at that choice: DiceGame offers it
      // on `keptDice.length + selectedRolls.length === 6` (DiceGame.tsx), so
      // the dice that complete the tutto are still `selected` inside
      // currentRoll — buildDiceSnapshot copies the two lists separately and
      // preserves the flags. `keptDice.length === 6` only ever happens AFTER
      // the player presses a button, which also sets stopped: true. Reading
      // keptDice alone therefore misses the real window entirely and charges
      // an AFK player a bust for a card they completed.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 2000,
          keptDice: [1, 2, 3].map(v => ({ id: `k${v}`, val: v })),
          currentRoll: [4, 5, 6].map(v => ({ id: `r${v}`, val: v, selected: true })),
          kniffelProgress: [1, 2, 3, 4, 5, 6], tuttosThisTurn: 1,
          cardsThisTurn: ['Kniffel'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesKniffelCompleted).toBe(1);
      expect(alice.timesKniffelFailed).toBe(0);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([{ card: 'Kniffel', completed: true }]);
      // The display concern the counters above don't cover: the log must not
      // print "busted on Kniffel" for a turn no bust was ever charged for.
      expect(rooms[roomId].state.historyLog?.at(-1)?.type).toBe('timeout');
    });

    it('keeps a banked tutto marked completed when the summary countdown times out', () => {
      // The counterpart to the split-shape case above, and the one a naive
      // `!stopped` guard breaks. Several DiceGame paths commit a COMPLETED
      // tutto and mark it stopped in the same breath (the classic bank/draw
      // choice at 'Finish', the modernized turn-ending tutto, the Kleeblatt
      // win): keptDice holds all six, currentRoll is emptied, stopped is true.
      // If the tab then dies during the summary countdown the server timer
      // fires — and the card must stay COMPLETED. stoppedBanked only decides
      // `ended`; it does not mark the card, so completion has to come from the
      // dice count alone.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 2000,
          keptDice: [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v })),
          currentRoll: [], kniffelProgress: [1, 2, 3, 4, 5, 6], tuttosThisTurn: 1,
          stopped: true,
          cardsThisTurn: ['Kniffel'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesKniffelCompleted, 'a banked tutto must not be recorded as failed').toBe(1);
      expect(alice.timesKniffelFailed).toBe(0);
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([{ card: 'Kniffel', completed: true }]);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
    });

    it('still counts a bust when only SOME of the current roll is selected', () => {
      // The counterpart the guard above must not swallow: five dice aside is
      // not the choice, it is an unresolved roll, and a timeout there is a
      // genuine null.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 300,
          keptDice: [1, 2, 3].map(v => ({ id: `k${v}`, val: v })),
          currentRoll: [{ id: 'r4', val: 4, selected: true }, { id: 'r5', val: 5, selected: true },
            { id: 'r6', val: 6, selected: false }],
          kniffelProgress: [1, 2, 3], tuttosThisTurn: 0,
          cardsThisTurn: ['Kniffel'], plusMinusScores: [], chainTuttoCount: 0,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(1);
      expect(alice.timesKniffelFailed).toBe(1);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('null');
    });

    it('does not invent a bust when the timeout lands on a Stop & Score summary countdown', () => {
      // The decision was made and committed into the snapshot (stopped: true);
      // only the short auto-continue never fired (tab died mid-countdown). No
      // null was rolled — but the card itself was never completed either (no
      // tutto), so the turn forfeits as 'timeout' without marking the card.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 450,
          keptDice: [{ id: 'k1', val: 1 }, { id: 'k2', val: 5 }],
          currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0, stopped: true,
          cardsThisTurn: ['Kniffel', '300'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesKniffelCompleted).toBe(1); // completed mid-chain
      // Still a forfeit: nothing banks, and the thrown-away total is recorded.
      expect(rooms[roomId].state.previousScore).toBe(0);
      expect(alice.highestForfeitedTurnScore).toBe(450);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([
        { card: 'Kniffel', completed: true },
        { card: '300', completed: false },
      ]);
    });

    it('counts no bust for a timeout on the classic Feuerwerk banks-on-null summary', () => {
      // The manual path banks that summary without a bust (the null is how a
      // Feuerwerk ENDS in classic); a client that died on it and timed out
      // must not be counted differently.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Feuerwerk', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 1500, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 1, busted: true,
          cardsThisTurn: ['300', 'Feuerwerk'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesFeuerwerkReceived).toBe(1);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
    });

    it('classifies a timeout during a drawn-Stop summary as the Stop forfeit, not a dice bust', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Stop', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 800, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 1,
          cardsThisTurn: ['300', 'Stop'],
          plusMinusScores: [],
          chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      expect(alice.timesSkipped).toBe(1);
      expect(alice.highestForfeitedTurnScore).toBe(800);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('stopCard');
    });

    it('does not invent a bust when the timeout lands on the drawn-card reveal', () => {
      // The reveal is the other place an AFK classic player parks (it has no
      // countdown either): the drawn card is in the chain but its first roll
      // never happened — an empty table, neither busted nor stopped. The
      // forfeit stands, but no null was ever rolled, so no bust; the drawn
      // card was never played, so it stays uncompleted. DiceGame's own
      // restore reads this exact snapshot as "resume by rolling", not a bust.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '500', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 1800, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 1,
          cardsThisTurn: ['300', '500'],
          plusMinusScores: [],
          chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts).toBe(0);
      // Still a forfeit: nothing banks, and the thrown-away total is recorded.
      expect(rooms[roomId].state.previousScore).toBe(0);
      expect(alice.highestForfeitedTurnScore).toBe(1800);
      expect(rooms[roomId].state.previousTurnSummary?.ended).toBe('timeout');
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([
        { card: '300', completed: true },
        { card: '500', completed: false },
      ]);
    });

    it('keeps the legacy timeout behavior for a MODERNIZED turn, whose snapshot carries no chain', () => {
      // Modernized only. A classic PHYSICAL turn also carries no dice, but it
      // does carry its chain (see the two cases below) — reading its absence
      // as "modernized" is what used to charge a physical chain a bust it
      // never rolled and throw its per-card counters away.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '200', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 100, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      expect(state.players[0].busts).toBe(1);
      expect(state.previousTurnSummary).toBeNull();
      const lastEntry = state.historyLog[state.historyLog.length - 1];
      expect(lastEntry.type).toBe('bust');
      expect(lastEntry.cards).toBeUndefined();
    });

    it('reconstructs a classic PHYSICAL chain from its dice-less snapshot', () => {
      // With real dice the app owns only the card draws and the typed total,
      // so the snapshot carries the chain and no dice at all. Read as
      // "modernized" it invented a bust (types.ts states the contract: a
      // timeout forfeits, but no null was rolled), lost every earlier card's
      // counter, lost all three classic records, and left previousTurnSummary
      // null — so undo handed back the LAST chain card and never returned the
      // earlier ones to the deck.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '400', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 2400, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
          cardsThisTurn: ['Kniffel', '400'], plusMinusScores: [], chainTuttoCount: 1,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.busts, 'a timeout forfeits, but no die was ever nulled').toBe(0);
      expect(alice.timesKniffelCompleted, 'the straight the chain continued FROM was completed').toBe(1);
      expect(alice.totalTuttos).toBe(1);
      expect(alice.mostCardsInTurn).toBe(2);
      expect(alice.highestForfeitedTurnScore).toBe(2400);

      const state = rooms[roomId].state;
      expect(state.previousTurnSummary?.ended).toBe('timeout');
      expect(state.previousTurnSummary?.cards, 'undo needs every card to put back').toEqual([
        { card: 'Kniffel', completed: true },
        { card: '400', completed: false },
      ]);
    });

    it('does not charge a failure for the card completed at the bank-or-draw choice', () => {
      // The state an AFK physical player actually parks in: they answered Yes,
      // the card is completed and the bank-or-draw choice is open. With no
      // dice to count, nothing in the snapshot says so — the digital path
      // reads it off six dice put aside, which physical can never produce — so
      // the completed card was booked as a failure.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kniffel', cards: ['300'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 2000, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0,
          cardsThisTurn: ['Kniffel'], plusMinusScores: [], chainTuttoCount: 1,
          lastCardCompleted: true,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const alice = rooms[roomId].state.players[0];
      expect(alice.timesKniffelCompleted, 'they made the straight').toBe(1);
      expect(alice.timesKniffelFailed).toBe(0);
      expect(alice.busts).toBe(0);
      expect(rooms[roomId].state.previousTurnSummary?.cards).toEqual([{ card: 'Kniffel', completed: true }]);
    });

    it('does not invent a bust when a MODERNIZED turn times out on a decided Stop & Score', () => {
      // Modernized snapshots carry no chain fields, so this never reaches the
      // summary path above — but `stopped` says just as plainly that the
      // player had already decided and banked, and only the auto-continue
      // never fired. The points are still forfeited like any timeout; a bust
      // is a dice null, which this turn never rolled.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 450,
          keptDice: [{ id: 'k1', val: 1 }, { id: 'k2', val: 5 }],
          currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0, stopped: true,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      expect(state.players[0].busts).toBe(0);
      expect(state.currentPlayerIndex).toBe(1);
      // Still a forfeit, and still the modernized path: no classic summary is
      // fabricated for a turn that never had a chain.
      expect(state.players[0].score).toBe(0);
      expect(state.previousScore).toBe(0);
      expect(state.previousWasBust).toBe(false);
      expect(state.previousTurnSummary).toBeNull();
      // Previously logged as a plain 'success' worth 0 pts — indistinguishable
      // from an ordinary turn that genuinely scored nothing.
      expect(state.historyLog?.at(-1)?.type).toBe('timeout');
    });

    it('still counts the bust when a modernized snapshot busted, stale stop marker or not', () => {
      // The marker only excuses the bust for a turn that was NOT busted — a
      // dice null is the one thing the bust counter is for.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 0, keptDice: [], currentRoll: [], kniffelProgress: [],
          tuttosThisTurn: 0, busted: true, stopped: true,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      expect(rooms[roomId].state.players[0].busts).toBe(1);
    });

    it('never turns a modernized timeout into a special card the player never finished', () => {
      // The engine only counts the bust for a card whose turn ends on a
      // score, and that is the only case the no-bust outcome above may claim
      // — a Yes/No card would take it as the card COMPLETED, paying out its
      // fixed value and, for Kleeblatt, the game itself.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: 'Kleeblatt', cards: ['200'],
        round: 1, winningScore: 6000, players: [makePlayer('Alice'), makePlayer('Bob')],
        liveTurnState: {
          turnScore: 3000,
          keptDice: [1, 2, 3, 4, 5, 6].map(v => ({ id: `d${v}`, val: v })),
          currentRoll: [], kniffelProgress: [], tuttosThisTurn: 1, stopped: true,
        },
      });
      advanceTurnOnTimeout(makeFakeIo().io, roomId);

      const state = rooms[roomId].state;
      expect(state.finished).toBe(false);
      expect(state.players[0].score).toBe(0);
      expect(state.players[0].timesKleeblattCompleted).toBe(0);
      expect(state.players[0].timesKleeblattFailed).toBe(1);
      // A special card never counted the bust to begin with.
      expect(state.players[0].busts).toBe(0);
      expect(state.currentPlayerIndex).toBe(1);
    });

    it('backstop: swallows an exception from a corrupted room state instead of crashing the process', () => {
      // Real pushState validation (pushValidation.ts) should make an
      // out-of-bounds currentPlayerIndex unreachable, but this handler runs off
      // a bare setTimeout with no caller to catch a throw — an uncaught
      // exception here would otherwise crash the whole process (every room,
      // every player), not just this one room's turn.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 5, // out of bounds for a 1-player roster
        players: [makePlayer('Alice')],
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { io, emit } = makeFakeIo();

      expect(() => advanceTurnOnTimeout(io, roomId)).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[turnTimer] Failed to advance turn for room ${roomId}`),
        expect.any(Error),
      );
      // The broadcast never fires for a failed advance.
      expect(emit).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('abortGameIfLowPlayers', () => {
    it('returns false and leaves state untouched when there are enough players', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'playing', players: [makePlayer('Alice'), makePlayer('Bob')] });
      const { io, emit } = makeFakeIo();
      const aborted = abortGameIfLowPlayers(io, rooms[roomId], roomId);
      expect(aborted).toBe(false);
      expect(rooms[roomId].state.status).toBe('playing');
      expect(emit).not.toHaveBeenCalled();
    });

    it('returns false when not currently playing, even with fewer than 2 players', () => {
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, { status: 'lobby', players: [makePlayer('Alice')] });
      const { io } = makeFakeIo();
      expect(abortGameIfLowPlayers(io, rooms[roomId], roomId)).toBe(false);
    });

    it('returns false for a finished game (end screen), even with fewer than 2 players', () => {
      // A finished game stays status 'playing' (finished=true) through the end
      // screen — the last remaining player's peer leaving/being kicked there
      // must not wipe their end screen or fire a misleading "game aborted" toast.
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      Object.assign(room.state, {
        status: 'playing', finished: true, players: [makePlayer('Alice')],
        currentCard: null, currentPlayerIndex: null,
      });
      const { io, emit } = makeFakeIo();
      expect(abortGameIfLowPlayers(io, room, roomId)).toBe(false);
      expect(room.state.status).toBe('playing');
      expect(room.state.finished).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });

    it('leaves the turn-timer bookkeeping fully idle, not partly', () => {
      // The four fields are one answer to "which turn have we already seen",
      // so every reset site clears all of them — a leftover lastDeckSize would
      // make the next pushState misread a fresh turn as one already scheduled.
      rooms[roomId] = createRoom('host-1');
      Object.assign(rooms[roomId].state, {
        status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: ['200'],
        round: 1, players: [makePlayer('Alice')],
      });
      rooms[roomId].turnTimerState = { lastCard: '300', lastPlayerIndex: 0, lastDeckSize: 1, restartsThisTurn: 7 };

      expect(abortGameIfLowPlayers(makeFakeIo().io, rooms[roomId], roomId)).toBe(true);

      expect(rooms[roomId].turnTimerState).toEqual({
        lastCard: null, lastPlayerIndex: null, lastDeckSize: null, restartsThisTurn: 0,
      });
    });

    it('aborts the game, resets play state, clears the timer, and emits gameAborted', () => {
      rooms[roomId] = createRoom('host-1');
      const room = rooms[roomId];
      room.gameActualStartTime = Date.now();
      room.turnTimerState = { lastCard: '200', lastPlayerIndex: 0, lastDeckSize: 5, restartsThisTurn: 2 };
      room.turnExpireTimer = setTimeout(() => {}, 10000);
      Object.assign(room.state, {
        status: 'playing', players: [makePlayer('Alice')], currentCard: '200', currentPlayerIndex: 0,
        finished: false, turnStartTime: Date.now(),
        // The last live dice snapshot — must not survive into the lobby,
        // where it would ride every broadcast until the next game.
        liveTurnState: { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });
      const { io, emit, to } = makeFakeIo();
      const aborted = abortGameIfLowPlayers(io, room, roomId);

      expect(aborted).toBe(true);
      // The namespaced channel, never the bare roomId — see roomChannel() in
      // rooms.ts for why a room may not broadcast on a name that could equal
      // a socket id.
      expect(to).toHaveBeenCalledWith(roomChannel(roomId));
      expect(emit).toHaveBeenCalledWith('gameAborted');
      expect(room.state.status).toBe('lobby');
      expect(room.state.currentCard).toBeNull();
      expect(room.state.currentPlayerIndex).toBeNull();
      expect(room.state.finished).toBe(false);
      expect(room.state.turnStartTime).toBeNull();
      expect(room.gameActualStartTime).toBeNull();
      expect(room.state.liveTurnState).toBeNull();
      expect(room.turnTimerState).toEqual({ lastCard: null, lastPlayerIndex: null, lastDeckSize: null, restartsThisTurn: 0 });
      expect(room.turnExpireTimer).toBeNull();
    });
  });
});

// Pure-function tests for the shared seconds->ms conversion both server timer
// sites arm with (the turn-expiry timer above, and socketRoomHandlers' seat
// reconnect timer). The local scaledTimeoutMs helper at the top of this file
// deliberately stays an independent mirror rather than calling this: tests
// that predict deadlines with the very function under test would drift in
// lockstep with any bug in it.
describe('scaledTimerMs', () => {
  it('compresses by TEST_TIMER_SCALE outside production', () => {
    expect(scaledTimerMs(60, { TEST_TIMER_SCALE: '0.2' })).toBe(12_000);
  });

  it('ignores the scale entirely in production', () => {
    expect(scaledTimerMs(60, { NODE_ENV: 'production', TEST_TIMER_SCALE: '0.2' })).toBe(60_000);
  });

  it('is unscaled when the variable is unset', () => {
    expect(scaledTimerMs(60, {})).toBe(60_000);
    expect(scaledTimerMs(60, { NODE_ENV: 'production' })).toBe(60_000);
  });

  // parseFloat used to let these through: 'abc' NaN-armed the timer (node
  // clamps that to ~1ms) and '0' floored every timer to 10ms — both worse
  // failure modes than simply running unscaled.
  it.each(['abc', '0', '-1', 'NaN', ''])('falls back to unscaled for junk value %j', (v) => {
    expect(scaledTimerMs(60, { TEST_TIMER_SCALE: v })).toBe(60_000);
  });

  it('never arms below the 10ms floor', () => {
    expect(scaledTimerMs(1, { TEST_TIMER_SCALE: '0.001' })).toBe(10);
    expect(scaledTimerMs(0, {})).toBe(10);
  });
});
