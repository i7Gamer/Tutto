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
      diceMode: 'digital',
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

  it('omits absent fields rather than filling them with undefined', () => {
    const picked = pickLocalGameState({ round: 5 });
    expect(picked).toEqual({ round: 5 });
    expect(Object.keys(picked)).toEqual(['round']);
  });

  it('drops whitelisted keys whose values fail their shape check (STORE-TEST-3 / STORE-SEC-2)', () => {
    // A hand-edited or corrupted save must not be able to put a string where
    // the store expects a number/array — the store keeps its initial default
    // for that field instead of crashing at first use (players.map, round
    // arithmetic, chart rendering, ...).
    const parsed = { round: 'five', players: 'not-an-array', winningScore: null, diceMode: 'digital' };
    const picked = pickLocalGameState(parsed);
    expect(picked).toEqual({ diceMode: 'digital' });
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
      diceMode: 'physical',
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
