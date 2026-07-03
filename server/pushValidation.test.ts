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
} from './pushValidation';
import { createRoom } from './rooms';
import type { RoomState, ServerPlayer } from './roomTypes';

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

const makeState = (playerNames: string[] = ['Alice', 'Bob']): RoomState => {
  const state = createRoom('sock-Alice').state;
  state.players = playerNames.map(n => makePlayer(n));
  return state;
};

const asHost = { isHost: true, startingGame: false };
const asActivePlayer = { isHost: false, startingGame: false };
const asHostStarting = { isHost: true, startingGame: true };

describe('applyPushedState', () => {
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
      applyPushedState(state, { status: 'playing', winningScore: 7777, turnDuration: 30, reconnectTimeout: 30, randomOrder: false, initialCards: { Stop: 1 } }, asActivePlayer);
      expect(state.status).toBe('lobby');
      expect(state.winningScore).toBe(6000);
      expect(state.turnDuration).toBe(120);
      expect(state.reconnectTimeout).toBe(60);
      expect(state.randomOrder).toBe(true);
      expect(state.initialCards.Stop).toBe(10);
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

    it('falls back to merge-in-place when the pushed list has duplicate names', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [{ name: 'Bob', score: 7 }, { name: 'Bob', score: 8 }],
      }, asHostStarting);
      expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
      expect(state.players[1].score).toBe(7); // first match wins
    });
  });

  describe('numeric config bounds (winningScore/turnDuration/reconnectTimeout)', () => {
    it.each([
      ['winningScore', 99999, true], ['winningScore', 100000, false], ['winningScore', -1, false],
      // Same MIN_WINNING_SCORE floor as updateConfig — pushState must not be a
      // side door for a winning score the config validator just rejected.
      ['winningScore', 1000, true], ['winningScore', 999, false], ['winningScore', 0, false],
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

    it('chartValues: one finite-number array per player', () => {
      const state = makeState();
      applyPushedState(state, { chartValues: [[100], [200]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[1]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[NaN], [2]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
    });

    it('chartNames: one string per player', () => {
      const state = makeState();
      applyPushedState(state, { chartNames: ['Alice', 'Bob'] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'Bob']);
      applyPushedState(state, { chartNames: ['Alice', 42] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'Bob']);
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
    });
    expect(state.winningScore).toBe(7777);
    expect(state.turnDuration).toBe(120);
    expect(state.reconnectTimeout).toBe(0);
    expect(state.randomOrder).toBe(true);
    expect(state.initialCards).toEqual({ Stop: 2 });
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
});
