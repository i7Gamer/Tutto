/**
 * @vitest-environment node
 *
 * In-process unit tests for the pushState validation/merge layer. The E2E
 * socket suites (sockets.test.ts, pushStateValidation.test.ts) prove the same
 * rules hold over the wire; these tests pin every individual field branch
 * cheaply and show up in coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  applyPushedState,
  applyValidatedConfig,
  validateInitialCards,
  validatePushedPlayers,
  isPlausiblePlayerSnapshot,
  isValidDiceSnapshot,
  sanitizeDiceSnapshot,
  isValidTurnSummary,
  sanitizeTurnSummary,
} from './pushValidation';
import { createRoom } from './rooms';
import { zeroedPlayerStats, PLAYER_STAT_FIELDS } from '../src/utils/playerStats';
import type { RoomState, ServerPlayer } from './roomTypes';

const makePlayer = (name: string, overrides: Partial<ServerPlayer> = {}): ServerPlayer => ({
  name,
  deviceId: `dev-${name}`,
  socketId: `sock-${name}`,
  ...zeroedPlayerStats(),
  position: 0,
  color: '#ff0000',
  disconnected: false,
  ...overrides,
});

const makeState = (playerNames: string[] = ['Alice', 'Bob']): RoomState => {
  const state = createRoom('sock-Alice').state;
  state.players = playerNames.map(n => makePlayer(n));
  return state;
};

const asHost = { isHost: true, startingGame: false };
const asActivePlayer = { isHost: false, startingGame: false };
const asHostStarting = { isHost: true, startingGame: true };

describe('applyPushedState', () => {
  it('accepts every stat a player accumulates', () => {
    // Derived from the one list that creates these fields, so a counter added
    // there and not admitted here fails this test rather than the players. A
    // broadcast replaces the roster wholesale: a stat this set does not accept
    // back is reset after every turn, for the whole room, silently — which is
    // what happened to the per-turn maxima before they were let in.
    const state = makeState();
    const accumulated = Object.fromEntries(PLAYER_STAT_FIELDS.map((field, i) => [field, i + 1]));

    applyPushedState(state, { players: [{ name: 'Alice', ...accumulated }, { name: 'Bob' }] }, asActivePlayer);

    for (const [field, value] of Object.entries(accumulated)) {
      expect(state.players[0][field as keyof ServerPlayer], field).toBe(value);
    }
  });

  describe('permission sets', () => {
    it('lets the host write host-only fields', () => {
      const state = makeState();
      applyPushedState(state, { status: 'playing', winningScore: 7777, randomOrder: false }, asHost);
      expect(state.status).toBe('playing');
      expect(state.winningScore).toBe(7777);
      expect(state.randomOrder).toBe(false);
    });

    it('ignores host-only fields from the active player', () => {
      const state = makeState();
      applyPushedState(state, { status: 'playing', winningScore: 7777, turnDuration: 30, reconnectTimeout: 30, randomOrder: false, initialCards: { Stop: 1 }, enforcedDiceMode: 'digital' }, asActivePlayer);
      expect(state.status).toBe('lobby');
      expect(state.winningScore).toBe(6000);
      expect(state.turnDuration).toBe(120);
      expect(state.reconnectTimeout).toBe(60);
      expect(state.randomOrder).toBe(true);
      expect(state.initialCards.Stop).toBe(10);
      expect(state.enforcedDiceMode).toBeNull();
    });

    it('lets the active player write game-progress fields', () => {
      const state = makeState();
      applyPushedState(state, { round: 3, finished: true, currentPlayerIndex: 1 }, asActivePlayer);
      expect(state.round).toBe(3);
      expect(state.finished).toBe(true);
      expect(state.currentPlayerIndex).toBe(1);
    });
  });

  describe('players merging', () => {
    it('merges mutable numeric fields by name, keeping identity fields', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 500, deviceId: 'HIJACK', socketId: 'HIJACK' },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(500);
      expect(state.players[1].score).toBe(300);
      expect(state.players[0].deviceId).toBe('dev-Alice');
      expect(state.players[0].socketId).toBe('sock-Alice');
    });

    it('rejects a players array with the wrong length', () => {
      const state = makeState();
      applyPushedState(state, { players: [{ name: 'Alice', score: 500 }] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    it('rejects a players array containing an unknown name', () => {
      const state = makeState();
      applyPushedState(state, { players: [{ name: 'Alice', score: 500 }, { name: 'Mallory', score: 1 }] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    it('rejects non-object player entries', () => {
      const state = makeState();
      applyPushedState(state, { players: ['Alice', 'Bob'] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    it('ignores non-finite numeric player fields and non-boolean disconnected', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: Infinity, busts: NaN, disconnected: 'yes' },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
      expect(state.players[0].busts).toBe(0);
      expect(state.players[0].disconnected).toBe(false);
      expect(state.players[1].score).toBe(300);
    });

    it('merges the per-card highest turn scores alongside the overall one', () => {
      // highestTurnScore was mergeable but its Feuerwerk/x2 siblings were not,
      // so every gameState broadcast (which replaces the client's roster
      // wholesale) reset them to undefined. That zeroed the two "Highest
      // Feuerwerk/x2 Turn" stats for online games end to end: endGameStats,
      // the global payload, EndScreen's new-record cards and the stats tiles.
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 1500, highestTurnScore: 1500, highestFeuerwerkTurnScore: 1500, highestX2TurnScore: 900 },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].highestTurnScore).toBe(1500);
      expect(state.players[0].highestFeuerwerkTurnScore).toBe(1500);
      expect(state.players[0].highestX2TurnScore).toBe(900);
    });

    it('applies the sanity cap to the per-card highest turn scores too', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', highestFeuerwerkTurnScore: 1e308, highestX2TurnScore: Infinity },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].highestFeuerwerkTurnScore).toBeUndefined();
      expect(state.players[0].highestX2TurnScore).toBeUndefined();
    });

    it('rejects a mutable numeric field magnitude beyond the sanity cap', () => {
      // A finite-but-absurd value (e.g. 1e308) would otherwise pass the
      // Number.isFinite check and ride every future broadcast to every client.
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 1e308, highestTurnScore: -1e308 },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
      expect(state.players[0].highestTurnScore).toBeUndefined();
      expect(state.players[1].score).toBe(300);
    });

    it('never lets a push overwrite disconnected, even with a valid boolean', () => {
      // The server is the sole owner of this flag (set from real socket
      // connectivity in handlePlayerLeave/joinRoom). A pushState composed
      // before the sender's client saw a peer's disconnect — e.g. the active
      // player's ~300ms live-dice pushState cadence — legitimately carries a
      // stale `disconnected: false` for that peer; accepting it would flip
      // the server's flag back and hide the disconnect indefinitely.
      const state = makeState();
      state.players[1].disconnected = true;
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 10 },
          { name: 'Bob', score: 20, disconnected: false },
        ],
      }, asActivePlayer);
      expect(state.players[1].disconnected).toBe(true);
      expect(state.players[1].score).toBe(20); // other mutable fields still merge normally

      // The reverse direction is blocked too — not just "false can't clear true".
      state.players[1].disconnected = false;
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 10 },
          { name: 'Bob', score: 30, disconnected: true },
        ],
      }, asActivePlayer);
      expect(state.players[1].disconnected).toBe(false);
    });

    it('accepts a valid color and rejects a malformed one', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', color: '#123abc' },
          { name: 'Bob', color: 'red' },
        ],
      }, asActivePlayer);
      expect(state.players[0].color).toBe('#123abc');
      expect(state.players[1].color).toBe('#ff0000');
    });

    it('adopts the pushed order when starting a game with a strict permutation', () => {
      const state = makeState();
      applyPushedState(state, {
        status: 'playing',
        players: [{ name: 'Bob', score: 0 }, { name: 'Alice', score: 0 }],
      }, asHostStarting);
      expect(state.players.map(p => p.name)).toEqual(['Bob', 'Alice']);
      expect(state.players[0].deviceId).toBe('dev-Bob');
    });

    it('keeps the server order outside a game start', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [{ name: 'Bob', score: 7 }, { name: 'Alice', score: 9 }],
      }, asHost);
      expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
      expect(state.players[0].score).toBe(9);
      expect(state.players[1].score).toBe(7);
    });

    it('rejects the whole players push when the pushed list has duplicate names (SERVER-PV-1)', () => {
      // Two pushed entries claiming the same name would both match that one
      // existing player in mergeMutable's name-keyed lookup — applying the
      // first and silently ignoring the second, while whichever other real
      // player the name doesn't belong to never gets its own update applied.
      // Safer to reject the entire players update than guess which was meant.
      const state = makeState();
      applyPushedState(state, {
        players: [{ name: 'Bob', score: 7 }, { name: 'Bob', score: 8 }],
      }, asHostStarting);
      expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
      expect(state.players[0].score).toBe(0);
      expect(state.players[1].score).toBe(0);
    });
  });

  describe('numeric config bounds (winningScore/turnDuration/reconnectTimeout)', () => {
    it.each([
      ['winningScore', 99999, true], ['winningScore', 100000, false], ['winningScore', -1, false],
      // Same MIN_WINNING_SCORE floor as updateConfig — pushState must not be a
      // side door for a winning score the config validator just rejected.
      ['winningScore', 1000, true], ['winningScore', 999, false], ['winningScore', 0, false],
      // Uses the real isValidWinningScore (integers only) rather than a local
      // bounds check — pushState must not be a side door for a fractional
      // winning score the config validator would also reject.
      ['winningScore', 6000.5, false], ['winningScore', NaN, false], ['winningScore', Infinity, false],
      // The timers deliberately keep a loose >= 0 sanity floor (tests push 1-2s turns).
      ['turnDuration', 1, true], ['turnDuration', -1, false],
      ['turnDuration', 600, true], ['turnDuration', 601, false], ['turnDuration', NaN, false],
      ['reconnectTimeout', 3600, true], ['reconnectTimeout', 3601, false], ['reconnectTimeout', Infinity, false],
    ] as [keyof RoomState, number, boolean][])('%s = %s accepted: %s', (field, value, accepted) => {
      const state = makeState();
      const before = state[field];
      applyPushedState(state, { [field]: value }, asHost);
      expect(state[field]).toBe(accepted ? value : before);
    });

    it('rejects non-numeric config values', () => {
      const state = makeState();
      applyPushedState(state, { winningScore: '9000' }, asHost);
      expect(state.winningScore).toBe(6000);
    });
  });

  describe('field shape checks', () => {
    it('initialCards: accepts a valid deck, rejects an invalid one', () => {
      const state = makeState();
      applyPushedState(state, { initialCards: { Stop: 3 } }, asHost);
      expect(state.initialCards).toEqual({ Stop: 3 });
      applyPushedState(state, { initialCards: { Bogus: 3 } }, asHost);
      expect(state.initialCards).toEqual({ Stop: 3 });
    });

    it('status: rejects values other than lobby/playing', () => {
      const state = makeState();
      applyPushedState(state, { status: 'hacked' }, asHost);
      expect(state.status).toBe('lobby');
    });

    it('randomOrder: rejects non-boolean', () => {
      const state = makeState();
      applyPushedState(state, { randomOrder: 1 }, asHost);
      expect(state.randomOrder).toBe(true);
    });

    it('enforcedDiceMode: accepts null and both dice modes, rejects junk', () => {
      const state = makeState();
      applyPushedState(state, { enforcedDiceMode: 'digital' }, asHost);
      expect(state.enforcedDiceMode).toBe('digital');
      applyPushedState(state, { enforcedDiceMode: 'physical' }, asHost);
      expect(state.enforcedDiceMode).toBe('physical');
      applyPushedState(state, { enforcedDiceMode: 'bogus' }, asHost);
      expect(state.enforcedDiceMode).toBe('physical');
      applyPushedState(state, { enforcedDiceMode: null }, asHost);
      expect(state.enforcedDiceMode).toBeNull();
    });

    it('ruleset: accepts both rule sets from the host while the write is allowed', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'classic' }, { ...asHost, allowRulesetWrite: true });
      expect(state.ruleset).toBe('classic');
      applyPushedState(state, { ruleset: 'modernized' }, { ...asHost, allowRulesetWrite: true });
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: rejects junk even while the write is allowed', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'official' }, { ...asHost, allowRulesetWrite: true });
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: refuses a write when allowRulesetWrite is absent (the mid-game case)', () => {
      // The caller passes allowRulesetWrite only for lobby / game-starting
      // pushes — a mid-game host push must not be able to flip the rules
      // under an active game.
      const state = makeState();
      applyPushedState(state, { ruleset: 'classic' }, asHost);
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: never accepted from the active player, allowed or not', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'classic' }, { ...asActivePlayer, allowRulesetWrite: true });
      expect(state.ruleset).toBe('modernized');
    });

    it('currentCard/previousCard: accepts null and valid cards, rejects junk', () => {
      const state = makeState();
      applyPushedState(state, { currentCard: 'Stop', previousCard: 'x2' }, asActivePlayer);
      expect(state.currentCard).toBe('Stop');
      expect(state.previousCard).toBe('x2');
      applyPushedState(state, { currentCard: 'NotACard', previousCard: null }, asActivePlayer);
      expect(state.currentCard).toBe('Stop');
      expect(state.previousCard).toBeNull();
    });

    it('cards: enforces card validity and the deck-size cap', () => {
      const state = makeState();
      applyPushedState(state, { cards: ['Stop', '200'] }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
      applyPushedState(state, { cards: ['Bogus'] }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
      applyPushedState(state, { cards: Array(99 * 11 + 1).fill('Stop') }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
    });

    it('currentPlayerIndex: accepts null and in-range integers only', () => {
      const state = makeState();
      applyPushedState(state, { currentPlayerIndex: 1 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: 2 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: -1 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: 0.5 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: null }, asActivePlayer);
      expect(state.currentPlayerIndex).toBeNull();
    });

    it('round: integer within [1, cap]', () => {
      const state = makeState();
      applyPushedState(state, { round: 5 }, asActivePlayer);
      expect(state.round).toBe(5);
      for (const bad of [0, 100001, 2.5, 'x']) {
        applyPushedState(state, { round: bad }, asActivePlayer);
        expect(state.round).toBe(5);
      }
    });

    it('finished: boolean only', () => {
      const state = makeState();
      applyPushedState(state, { finished: 'true' }, asActivePlayer);
      expect(state.finished).toBe(false);
    });

    it('previousScore: null or magnitude-capped finite number', () => {
      const state = makeState();
      applyPushedState(state, { previousScore: -350 }, asActivePlayer);
      expect(state.previousScore).toBe(-350);
      applyPushedState(state, { previousScore: 1_000_001 }, asActivePlayer);
      expect(state.previousScore).toBe(-350);
      applyPushedState(state, { previousScore: null }, asActivePlayer);
      expect(state.previousScore).toBeNull();
    });

    it('previousLeaders: null, or plausible snapshots capped at player count', () => {
      const state = makeState();
      applyPushedState(state, { previousLeaders: [{ name: 'Alice', score: 100 }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: [{ name: 'A', score: 1 }, { name: 'B', score: 2 }, { name: 'C', score: 3 }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: [{ name: 'Alice' }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: null }, asActivePlayer);
      expect(state.previousLeaders).toBeNull();
    });

    it('previousLeaders: strips fields beyond name/score from each entry', () => {
      // isPlausiblePlayerSnapshot only shape-checks name/score — without
      // rebuilding the entries, an extra property would ride along into
      // every future broadcast of previousLeaders.
      const state = makeState();
      applyPushedState(state, {
        previousLeaders: [{ name: 'Alice', score: 100, deviceId: 'HIJACK', extra: 'junk' }],
      }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
    });

    it('previousWasBust: boolean only', () => {
      const state = makeState();
      applyPushedState(state, { previousWasBust: true }, asActivePlayer);
      expect(state.previousWasBust).toBe(true);
      applyPushedState(state, { previousWasBust: 1 }, asActivePlayer);
      expect(state.previousWasBust).toBe(true);
    });

    it('previousHighestTurnScore: non-negative magnitude-capped number', () => {
      const state = makeState();
      applyPushedState(state, { previousHighestTurnScore: 900 }, asActivePlayer);
      expect(state.previousHighestTurnScore).toBe(900);
      for (const bad of [-1, 1_000_001, NaN]) {
        applyPushedState(state, { previousHighestTurnScore: bad }, asActivePlayer);
        expect(state.previousHighestTurnScore).toBe(900);
      }
    });

    it('previousHighestFeuerwerkTurnScore/previousHighestX2TurnScore: non-negative magnitude-capped numbers', () => {
      const state = makeState();
      applyPushedState(state, { previousHighestFeuerwerkTurnScore: 900, previousHighestX2TurnScore: 700 }, asActivePlayer);
      expect(state.previousHighestFeuerwerkTurnScore).toBe(900);
      expect(state.previousHighestX2TurnScore).toBe(700);
      for (const bad of [-1, 1_000_001, NaN]) {
        applyPushedState(state, { previousHighestFeuerwerkTurnScore: bad, previousHighestX2TurnScore: bad }, asActivePlayer);
        expect(state.previousHighestFeuerwerkTurnScore).toBe(900);
        expect(state.previousHighestX2TurnScore).toBe(700);
      }
    });

    it('previousPlayerName: null or a non-empty string up to 30 chars', () => {
      const state = makeState();
      applyPushedState(state, { previousPlayerName: 'Alice' }, asActivePlayer);
      expect(state.previousPlayerName).toBe('Alice');
      applyPushedState(state, { previousPlayerName: null }, asActivePlayer);
      expect(state.previousPlayerName).toBeNull();
      applyPushedState(state, { previousPlayerName: 'Bob' }, asActivePlayer);
      for (const bad of ['', 'x'.repeat(31), 123, undefined]) {
        applyPushedState(state, { previousPlayerName: bad }, asActivePlayer);
        expect(state.previousPlayerName).toBe('Bob');
      }
    });

    it('chartValues: one finite-number array per player', () => {
      const state = makeState();
      applyPushedState(state, { chartValues: [[100], [200]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[1]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[NaN], [2]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
    });

    it('chartNames: one non-empty string per player, capped at name length', () => {
      const state = makeState();
      applyPushedState(state, { chartNames: ['Alice', 'Bob'] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'Bob']);
      // These are player names, so they follow the same 1-30 char rule as
      // previousPlayerName/historyLog — without the cap this was the one
      // client-pushed string the server stored unbounded and re-broadcast to
      // every client on each subsequent state change.
      for (const bad of [['Alice', 42], ['Alice', ''], ['Alice', 'x'.repeat(31)]]) {
        applyPushedState(state, { chartNames: bad }, asActivePlayer);
        expect(state.chartNames).toEqual(['Alice', 'Bob']);
      }
      applyPushedState(state, { chartNames: ['Alice', 'x'.repeat(30)] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'x'.repeat(30)]);
    });

    it('chartLabels: finite numbers within the rounds cap', () => {
      const state = makeState();
      applyPushedState(state, { chartLabels: [1, 2] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);
      applyPushedState(state, { chartLabels: [1, 'x'] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);
    });

    it('gameTimeInSeconds: non-negative capped number', () => {
      const state = makeState();
      applyPushedState(state, { gameTimeInSeconds: 42 }, asActivePlayer);
      expect(state.gameTimeInSeconds).toBe(42);
      for (const bad of [-1, 10_000_001, NaN]) {
        applyPushedState(state, { gameTimeInSeconds: bad }, asActivePlayer);
        expect(state.gameTimeInSeconds).toBe(42);
      }
    });

    it('liveTurnState: null or a valid dice snapshot', () => {
      const state = makeState();
      const snapshot = { turnScore: 100, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };
      applyPushedState(state, { liveTurnState: snapshot }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, keptDice: Array(7).fill({}) } }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: null }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
    });

    it('liveTurnState: rejects a snapshot whose dice elements are malformed', () => {
      // A spectator's client renders keptDice/currentRoll entries' `.val`
      // directly into JSX — a malformed element reaching a broadcast crashes
      // every viewer's render. The whole snapshot must be rejected (keeping
      // the last good one), not merged in with a bad element left inside.
      const state = makeState();
      const snapshot = { turnScore: 100, tuttosThisTurn: 0, keptDice: [{ id: 'd1', val: 4 }], currentRoll: [], kniffelProgress: [] };
      applyPushedState(state, { liveTurnState: snapshot }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);

      applyPushedState(state, { liveTurnState: { ...snapshot, keptDice: [{ id: 'd1', val: 'boom' }] } }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, currentRoll: [{ id: 'd2', val: 3 }] } }, asActivePlayer); // missing `selected`
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, kniffelProgress: [0] } }, asActivePlayer); // out of 1-6 range
      expect(state.liveTurnState).toEqual(snapshot);
    });

    it('liveTurnState: rejects a malformed rollingDiceIds/busted, accepts well-formed ones', () => {
      const state = makeState();
      const snapshot = { turnScore: 0, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };

      // createRoom() initializes liveTurnState to null — a rejected push
      // leaves that untouched (RT-1: the field is required, always one of
      // DiceSnapshot | null, never undefined).
      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: [123] } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: Array(7).fill('d1') } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
      applyPushedState(state, { liveTurnState: { ...snapshot, busted: 'yes' } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();

      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: ['d1', 'd2'], busted: true } }, asActivePlayer);
      expect(state.liveTurnState).toEqual({ ...snapshot, rollingDiceIds: ['d1', 'd2'], busted: true });
    });

    it('liveTurnState: strips fields beyond the known snapshot shape', () => {
      // Every field is shape-checked, but a valid snapshot with an extra
      // property attached would otherwise still be stored (and rebroadcast)
      // as-is — the same class of hole isValidDiceSnapshot exists to close.
      const state = makeState();
      applyPushedState(state, {
        liveTurnState: {
          turnScore: 50, tuttosThisTurn: 0,
          keptDice: [{ id: 'd1', val: 4, extra: 'junk' }],
          currentRoll: [{ id: 'd2', val: 2, selected: true, extra: 'junk' }],
          kniffelProgress: [],
          maliciousField: { toString: () => 'boom' },
        },
      }, asActivePlayer);
      expect(state.liveTurnState).toEqual({
        turnScore: 50, tuttosThisTurn: 0,
        keptDice: [{ id: 'd1', val: 4 }],
        currentRoll: [{ id: 'd2', val: 2, selected: true }],
        kniffelProgress: [],
      });
    });

    it('historyLog: validates and sanitizes pushed history log', () => {
      const state = makeState();
      const validEntry = {
        id: '1-Alice-1',
        round: 1,
        playerName: 'Alice',
        card: 'x2',
        type: 'success',
        score: 1000,
        playerColor: '#ffffff',
      };

      // Valid push
      applyPushedState(state, { historyLog: [validEntry] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid field: score too large
      applyPushedState(state, { historyLog: [{ ...validEntry, score: 2_000_000 }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]); // should reject and keep valid

      // Invalid type
      applyPushedState(state, { historyLog: [{ ...validEntry, type: 'cheated' }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid card type
      applyPushedState(state, { historyLog: [{ ...validEntry, card: 'SuperCard' }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid player name length
      applyPushedState(state, { historyLog: [{ ...validEntry, playerName: 'a'.repeat(31) }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Valid optional deducted players
      const validPlusMinus = {
        id: '2-Bob-3',
        round: 2,
        playerName: 'Bob',
        card: 'Plus_Minus',
        type: 'success',
        score: 1000,
        deductedPlayers: ['Alice'],
      };
      applyPushedState(state, { historyLog: [validPlusMinus] }, asActivePlayer);
      expect(state.historyLog).toEqual([validPlusMinus]);
    });
  });
});

describe('validateInitialCards', () => {
  it('rejects non-objects, empty objects, unknown keys, and out-of-range counts', () => {
    expect(validateInitialCards(null)).toBe(false);
    expect(validateInitialCards('deck')).toBe(false);
    expect(validateInitialCards({})).toBe(false);
    expect(validateInitialCards({ Bogus: 1 })).toBe(false);
    expect(validateInitialCards({ Stop: -1 })).toBe(false);
    expect(validateInitialCards({ Stop: 100 })).toBe(false);
    expect(validateInitialCards({ Stop: 1.5 })).toBe(false);
  });

  it('rejects an all-zero deck and accepts a playable one', () => {
    expect(validateInitialCards({ Stop: 0, x2: 0 })).toBe(false);
    expect(validateInitialCards({ Stop: 0, x2: 1 })).toBe(true);
  });
});

describe('applyValidatedConfig', () => {
  it('applies only the fields that pass validation', () => {
    const state = makeState();
    applyValidatedConfig(state, {
      winningScore: 7777,      // valid
      turnDuration: 5,         // below minimum — ignored
      reconnectTimeout: 0,     // valid ("off")
      randomOrder: 'yes',      // not boolean — ignored
      initialCards: { Stop: 2 }, // valid
      enforcedDiceMode: 'digital', // valid
      ruleset: 'classic',      // valid
    });
    expect(state.winningScore).toBe(7777);
    expect(state.turnDuration).toBe(120);
    expect(state.reconnectTimeout).toBe(0);
    expect(state.randomOrder).toBe(true);
    expect(state.initialCards).toEqual({ Stop: 2 });
    expect(state.enforcedDiceMode).toBe('digital');
    expect(state.ruleset).toBe('classic');
  });

  it('ignores an invalid ruleset value', () => {
    const state = makeState();
    applyValidatedConfig(state, { ruleset: 'bogus' });
    expect(state.ruleset).toBe('modernized');
  });

  it('applies enforcedDiceMode: null (turning enforcement back off)', () => {
    const state = makeState();
    state.enforcedDiceMode = 'digital';
    applyValidatedConfig(state, { enforcedDiceMode: null });
    expect(state.enforcedDiceMode).toBeNull();
  });

  it('ignores an invalid enforcedDiceMode value', () => {
    const state = makeState();
    applyValidatedConfig(state, { enforcedDiceMode: 'bogus' });
    expect(state.enforcedDiceMode).toBeNull();
  });
});

describe('validatePushedPlayers', () => {
  const existing = [makePlayer('Alice'), makePlayer('Bob')];

  it('accepts a same-length list of known names', () => {
    expect(validatePushedPlayers(existing, [{ name: 'Bob' }, { name: 'Alice' }])).toBe(true);
  });

  it('rejects non-arrays, wrong lengths, unknown names, and null entries', () => {
    expect(validatePushedPlayers(existing, 'players' as unknown as unknown[])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }, { name: 'Eve' }])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }, null])).toBe(false);
  });

  it('rejects a pushed list with duplicate names, even if every name is otherwise known (SERVER-PV-1)', () => {
    expect(validatePushedPlayers(existing, [{ name: 'Bob' }, { name: 'Bob' }])).toBe(false);
  });
});

describe('isPlausiblePlayerSnapshot', () => {
  it('requires an object with a string name and finite numeric score', () => {
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: 1 })).toBe(true);
    expect(isPlausiblePlayerSnapshot(null)).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A' })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 1, score: 1 })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: NaN })).toBe(false);
  });
});

describe('isValidDiceSnapshot', () => {
  const valid = { turnScore: 0, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };

  it('accepts a minimal valid snapshot', () => {
    expect(isValidDiceSnapshot(valid)).toBe(true);
  });

  it('rejects non-objects, non-finite scores, and over-long arrays', () => {
    expect(isValidDiceSnapshot(null)).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, turnScore: NaN })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, tuttosThisTurn: Infinity })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, keptDice: Array(7).fill(0) })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, currentRoll: Array(7).fill(0) })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: Array(7).fill(0) })).toBe(false);
  });

  it('accepts well-formed dice/kniffel-progress elements', () => {
    expect(isValidDiceSnapshot({
      ...valid,
      keptDice: [{ id: 'd1', val: 6 }],
      currentRoll: [{ id: 'd2', val: 3, selected: true }, { id: 'd3', val: 1, selected: false }],
      kniffelProgress: [1, 2, 3],
    })).toBe(true);
  });

  it('rejects malformed keptDice elements', () => {
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 'not-a-number' }] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1' }] })).toBe(false); // missing val
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ val: 4 }] })).toBe(false); // missing id
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 123, val: 4 }] })).toBe(false); // id not a string
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 0 }] })).toBe(false); // val out of 1-6
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 7 }] })).toBe(false); // val out of 1-6
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 3.5 }] })).toBe(false); // non-integer
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: '', val: 3 }] })).toBe(false); // empty id
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'x'.repeat(65), val: 3 }] })).toBe(false); // id too long
    expect(isValidDiceSnapshot({ ...valid, keptDice: ['not-an-object'] })).toBe(false);
  });

  it('rejects malformed currentRoll elements', () => {
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 3 }] })).toBe(false); // missing selected
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 3, selected: 'yes' }] })).toBe(false); // selected not boolean
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 9, selected: true }] })).toBe(false); // val out of range
  });

  it('rejects malformed kniffelProgress entries', () => {
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [0] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [7] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: ['1'] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [1.5] })).toBe(false);
  });

  it('accepts a well-formed optional busted/rollingDiceIds, or their absence', () => {
    expect(isValidDiceSnapshot(valid)).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, busted: true })).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: ['d1', 'd2'] })).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [] })).toBe(true);
  });

  it('rejects a malformed optional busted/rollingDiceIds', () => {
    expect(isValidDiceSnapshot({ ...valid, busted: 'yes' })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: 'd1' })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [123] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [''] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: ['x'.repeat(65)] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: Array(7).fill('d1') })).toBe(false);
  });
});

describe('classic chain fields (snapshot / history / turn summary)', () => {
  const validSnapshot = {
    turnScore: 100,
    keptDice: [{ id: 'd1', val: 1 }],
    currentRoll: [{ id: 'd2', val: 5, selected: false }],
    kniffelProgress: [],
    tuttosThisTurn: 0,
  };

  it('accepts and copies optional chain fields on a dice snapshot', () => {
    const withChain = {
      ...validSnapshot,
      cardsThisTurn: ['300', 'x2'],
      plusMinusSuccesses: 1,
      chainTuttoCount: 2,
    };
    expect(isValidDiceSnapshot(withChain)).toBe(true);
    const clean = sanitizeDiceSnapshot(withChain);
    expect(clean.cardsThisTurn).toEqual(['300', 'x2']);
    expect(clean.plusMinusSuccesses).toBe(1);
    expect(clean.chainTuttoCount).toBe(2);
    // Still absent when not sent — old clients keep working.
    expect(sanitizeDiceSnapshot(validSnapshot).cardsThisTurn).toBeUndefined();
  });

  it('rejects malformed chain fields on a dice snapshot', () => {
    expect(isValidDiceSnapshot({ ...validSnapshot, cardsThisTurn: ['NotACard'] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, cardsThisTurn: Array(101).fill('200') })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, plusMinusSuccesses: -1 })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, chainTuttoCount: 1.5 })).toBe(false);
  });

  const validSummary = {
    cards: [{ card: '300', completed: true }, { card: 'Stop', completed: false }],
    tuttoCount: 1,
    plusMinusSuccesses: 0,
    ended: 'stopCard',
  };

  it('validates and sanitizes a turn summary', () => {
    expect(isValidTurnSummary(validSummary)).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, ended: 'later' })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, cards: [{ card: 'Nope', completed: true }] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, tuttoCount: -1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: [''] })).toBe(false);

    const withExtra = { ...validSummary, deductedPlayers: ['Bob', 'Bob'], junk: 'x' };
    const clean = sanitizeTurnSummary(withExtra as never);
    expect(clean).toEqual({ ...validSummary, deductedPlayers: ['Bob', 'Bob'] });
    expect('junk' in clean).toBe(false);
  });

  it('lets the active player push previousTurnSummary, validated and sanitized', () => {
    const state = makeState();
    applyPushedState(state, { previousTurnSummary: { ...validSummary, junk: 'x' } }, asActivePlayer);
    expect(state.previousTurnSummary).toEqual(validSummary);
    applyPushedState(state, { previousTurnSummary: null }, asActivePlayer);
    expect(state.previousTurnSummary).toBeNull();
    applyPushedState(state, { previousTurnSummary: { ...validSummary, ended: 'bogus' } }, asActivePlayer);
    expect(state.previousTurnSummary).toBeNull(); // invalid → ignored
  });

  it('accepts a history entry carrying a chain card list, and strips a bad one', () => {
    const state = makeState();
    const entry = {
      id: '1-Alice-1', round: 1, playerName: 'Alice', card: '300',
      type: 'success', score: 2800, cards: ['300', 'Kniffel'],
    };
    applyPushedState(state, { historyLog: [entry] }, asActivePlayer);
    expect(state.historyLog).toHaveLength(1);
    expect(state.historyLog[0].cards).toEqual(['300', 'Kniffel']);

    applyPushedState(state, { historyLog: [{ ...entry, cards: ['NotACard'] }] }, asActivePlayer);
    // The malformed entry is rejected, so the log keeps its previous value.
    expect(state.historyLog[0].cards).toEqual(['300', 'Kniffel']);
  });
});
