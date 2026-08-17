/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { pickLocalGameState } from './persistence';

describe('pickLocalGameState', () => {
  it('returns an empty object for non-object or null input', () => {
    expect(pickLocalGameState(null)).toEqual({});
    expect(pickLocalGameState('corrupt')).toEqual({});
    expect(pickLocalGameState(42)).toEqual({});
  });

  it('keeps only known local-game-state fields', () => {
    const parsed = {
      players: [{ name: 'Alice', score: 100 }],
      round: 3,
      winningScore: 7000,
      gameTimeInSeconds: 42,
    };
    expect(pickLocalGameState(parsed)).toEqual(parsed);
  });

  it('drops fields outside the known whitelist, including action names', () => {
    // A corrupted or hand-edited save must not be able to clobber a store
    // action (e.g. `startGame`) by Object.assign'ing an arbitrary key into it.
    const parsed = {
      round: 3,
      startGame: 'not a function anymore',
      __proto__: { polluted: true },
      randomJunkKey: 123,
    };
    const picked = pickLocalGameState(parsed);
    expect(picked).toEqual({ round: 3 });
    expect('startGame' in picked).toBe(false);
    expect('randomJunkKey' in picked).toBe(false);
  });

  // The shape check was every-entry-valid, which an empty object satisfies
  // vacuously and an all-zero deck satisfies outright — so both survived the
  // restore. Either leaves the deck with no cards to draw, currentCard
  // permanently null and the game unplayable. The server has refused both
  // since validateInitialCards was written; this side had not.
  it('drops a restored deck that has no cards in it', () => {
    expect(pickLocalGameState({ initialCards: {} })).toEqual({});
    expect(pickLocalGameState({ initialCards: { Stop: 0, Kleeblatt: 0 } })).toEqual({});
  });

  it('keeps a deck as long as one card type is stocked', () => {
    const sparse = { initialCards: { Stop: 0, Kleeblatt: 1 } };
    expect(pickLocalGameState(sparse)).toEqual(sparse);
  });

  it('omits absent fields rather than filling them with undefined', () => {
    const picked = pickLocalGameState({ round: 5 });
    expect(picked).toEqual({ round: 5 });
    expect(Object.keys(picked)).toEqual(['round']);
  });

  it('keeps a valid ruleset and drops an invalid one', () => {
    // A saved classic game must resume classic — but junk (or an old save
    // without the field) leaves the store default in place.
    expect(pickLocalGameState({ ruleset: 'classic' })).toEqual({ ruleset: 'classic' });
    expect(pickLocalGameState({ ruleset: 'official' })).toEqual({});
    expect(pickLocalGameState({})).toEqual({});
  });

  it('drops whitelisted keys whose values fail their shape check (STORE-TEST-3 / STORE-SEC-2)', () => {
    // A hand-edited or corrupted save must not be able to put a string where
    // the store expects a number/array — the store keeps its initial default
    // for that field instead of crashing at first use (players.map, round
    // arithmetic, chart rendering, ...).
    const parsed = { round: 'five', players: 'not-an-array', winningScore: null, gameTimeInSeconds: 42 };
    const picked = pickLocalGameState(parsed);
    expect(picked).toEqual({ gameTimeInSeconds: 42 });
  });

  it('drops corrupted values field-by-field while keeping the valid rest of the save', () => {
    const picked = pickLocalGameState({
      players: [{ name: 'Alice', score: 100 }],
      round: 4,
      cards: ['Stop', 'NotACard'],
      status: 'corrupted-status',
      chartValues: [[100, 200], 'not-a-row'],
      historyLog: [{ id: '1-Alice-1', playerName: 'Alice', card: 'Stop', type: 'skip', round: 1, score: 0 }, 'junk'],
      gameTimeInSeconds: -5,
    });
    expect(picked).toEqual({ players: [{ name: 'Alice', score: 100 }], round: 4 });
  });

  it('rejects players with a missing/corrupted identity or score, or non-primitive stat fields', () => {
    expect(pickLocalGameState({ players: [{ name: '', score: 0 }] })).toEqual({});
    expect(pickLocalGameState({ players: [{ name: 'Alice', score: NaN }] })).toEqual({});
    expect(pickLocalGameState({ players: [{ name: 'Alice', score: 10, busts: { evil: true } }] })).toEqual({});
    expect(pickLocalGameState({ players: [{ name: 'Alice' }] })).toEqual({});
  });

  it('rejects the whole roster when it contains duplicate names (case-insensitive)', () => {
    // Duplicate names break every name-keyed lookup (Plus/Minus deduction,
    // undo, React keys) — the server and LocalLobby both refuse to create
    // this state normally, so it can only arise from a hand-edited save.
    expect(pickLocalGameState({
      players: [{ name: 'Alice', score: 100 }, { name: 'alice', score: 50 }],
    })).toEqual({});
    expect(pickLocalGameState({
      players: [{ name: 'Alice', score: 100 }, { name: 'Bob', score: 50 }],
    })).toEqual({
      players: [{ name: 'Alice', score: 100 }, { name: 'Bob', score: 50 }],
    });
  });

  it('drops a currentPlayerIndex that points past the restored roster (or has no roster at all)', () => {
    // Index saved against a 3-player roster, but the roster itself was
    // corrupted and dropped — the index alone would activate a turn for a
    // player who does not exist.
    expect(pickLocalGameState({ currentPlayerIndex: 2, players: 'corrupt' })).toEqual({});
    expect(pickLocalGameState({ currentPlayerIndex: 2, players: [{ name: 'A', score: 0 }] })).toEqual({
      players: [{ name: 'A', score: 0 }],
    });
    // In-bounds index with its roster restores fine; null is always allowed.
    expect(pickLocalGameState({ currentPlayerIndex: 0, players: [{ name: 'A', score: 0 }] })).toEqual({
      currentPlayerIndex: 0,
      players: [{ name: 'A', score: 0 }],
    });
    expect(pickLocalGameState({ currentPlayerIndex: null })).toEqual({ currentPlayerIndex: null });
  });

  it('drops chart rows saved for a roster of a different size', () => {
    // chartValues/chartNames are player-indexed (one row per player) —
    // restoring rows for a bigger roster makes nextTurn's round-end
    // bookkeeping index players[i] past the end of the restored roster and
    // crash on the next round end.
    const players = [{ name: 'A', score: 0 }, { name: 'B', score: 0 }];
    expect(pickLocalGameState({
      players,
      chartValues: [[10], [20], [30]],
      chartNames: ['A', 'B', 'C'],
      chartLabels: [1],
    })).toEqual({ players, chartLabels: [1] });

    // Matching lengths restore unchanged.
    expect(pickLocalGameState({
      players, chartValues: [[1], [2]], chartNames: ['A', 'B'],
    })).toEqual({ players, chartValues: [[1], [2]], chartNames: ['A', 'B'] });

    // No roster restored at all — the rows have nothing to align to.
    expect(pickLocalGameState({ chartValues: [[1]], chartNames: ['A'] })).toEqual({});
  });

  // tutto_diceMode is where the per-device preference lives, and init()
  // applies it AFTER the save so it already wins there. Carrying it in the
  // save too let setMode('local') — which does not re-read that key — restore
  // whatever the last local game happened to be saved under, so the store and
  // the persisted preference disagreed until the next reload.
  it('leaves diceMode out of the game save — it is a device preference, not game state', () => {
    expect(pickLocalGameState({ diceMode: 'physical', round: 3 })).toEqual({ round: 3 });
  });

  // Unlike the server's validators, these keep an entry whole rather than
  // rebuilding it — so deductedAmounts round-trips through localStorage
  // unchecked. The activity log then adds it up (summarizeDeductions), and a
  // string element makes that `0 + "400"` and prints "0400" as the amount.
  describe('per-deduction amounts in a restored save', () => {
    const bareEntry = {
      id: '3-Alice-2', playerName: 'Alice', card: 'Plus_Minus',
      type: 'success', round: 3, score: 1000,
    };
    const historyEntry = { ...bareEntry, deductedPlayers: ['Bob'] };

    it('keeps well-formed amounts on a history entry and drops corrupted ones', () => {
      const valid = { ...historyEntry, deductedAmounts: [400] };
      expect(pickLocalGameState({ historyLog: [valid] })).toEqual({ historyLog: [valid] });

      expect(pickLocalGameState({ historyLog: [{ ...historyEntry, deductedAmounts: ['400'] }] })).toEqual({});
      expect(pickLocalGameState({ historyLog: [{ ...historyEntry, deductedAmounts: [null] }] })).toEqual({});
      expect(pickLocalGameState({ historyLog: [{ ...historyEntry, deductedAmounts: 400 }] })).toEqual({});

      // The log reads names and amounts by index (summarizeDeductions), so a
      // mismatched pair would print one player's amount against another's
      // name — same rule as the server's validators.
      expect(pickLocalGameState({ historyLog: [{ ...historyEntry, deductedAmounts: [400, 400] }] })).toEqual({});
      expect(pickLocalGameState({ historyLog: [{ ...historyEntry, deductedAmounts: [] }] })).toEqual({});
      expect(pickLocalGameState({ historyLog: [{ ...bareEntry, deductedAmounts: [400] }] })).toEqual({});

      // A save written before the field existed carries none, and restores.
      expect(pickLocalGameState({ historyLog: [historyEntry] })).toEqual({ historyLog: [historyEntry] });
    });

    it('keeps well-formed amounts on a turn summary and drops corrupted ones', () => {
      const bareSummary = {
        cards: [{ card: 'Plus_Minus', completed: true }],
        tuttoCount: 1,
        plusMinusScores: [0],
        ended: 'banked',
      };
      const summary = { ...bareSummary, deductedPlayers: ['Bob'] };
      const valid = { ...summary, deductedAmounts: [400] };
      expect(pickLocalGameState({ previousTurnSummary: valid })).toEqual({ previousTurnSummary: valid });

      expect(pickLocalGameState({ previousTurnSummary: { ...summary, deductedAmounts: ['400'] } })).toEqual({});
      expect(pickLocalGameState({ previousTurnSummary: { ...summary, deductedAmounts: [null] } })).toEqual({});
      expect(pickLocalGameState({ previousTurnSummary: { ...summary, deductedAmounts: 400 } })).toEqual({});

      // Same index-alignment rule as the history entry above.
      expect(pickLocalGameState({ previousTurnSummary: { ...summary, deductedAmounts: [400, 400] } })).toEqual({});
      expect(pickLocalGameState({ previousTurnSummary: { ...summary, deductedAmounts: [] } })).toEqual({});
      expect(pickLocalGameState({ previousTurnSummary: { ...bareSummary, deductedAmounts: [400] } })).toEqual({});

      expect(pickLocalGameState({ previousTurnSummary: summary })).toEqual({ previousTurnSummary: summary });
    });
  });

  it('restores a realistic well-formed mid-game save unchanged', () => {
    const save = {
      players: [
        { name: 'Alice', score: 1200, busts: 1, totalTurns: 5, color: '#ff0000' },
        { name: 'Bob', score: 800, busts: 0, totalTurns: 5 },
      ],
      currentPlayerIndex: 1,
      currentCard: 'Feuerwerk',
      cards: ['Stop', '200', 'Kniffel'],
      round: 6,
      winningScore: 6000,
      randomOrder: false,
      turnDuration: 120,
      reconnectTimeout: 60,
      finished: false,
      previousScore: 350,
      previousCard: '300',
      previousLeaders: null,
      previousWasBust: false,
      previousHighestTurnScore: 350,
      previousPlayerName: 'Alice',
      chartValues: [[200, 700, 1200], [300, 500, 800]],
      chartNames: ['Alice', 'Bob'],
      chartLabels: [1, 2, 3],
      status: 'playing',
      historyLog: [{ id: '6-Alice-5', playerName: 'Alice', card: '300', type: 'success', round: 6, score: 350 }],
      gameTimeInSeconds: 480,
    };
    expect(pickLocalGameState(save)).toEqual(save);
  });
});
