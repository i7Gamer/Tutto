import { describe, it, expect, beforeEach } from 'vitest';
import { deriveRestoredTurn, readRestorableTurn } from './diceTurnRestore';
import { DICE_TURN_STATE_KEY } from './diceTurnState';
import type { DiceSnapshot } from '../types';

const snapshot = (over: Partial<DiceSnapshot> = {}): DiceSnapshot => ({
  turnScore: 0,
  keptDice: [],
  currentRoll: [],
  kniffelProgress: [],
  tuttosThisTurn: 0,
  busted: false,
  ...over,
});

const dice = (...vals: number[]) => vals.map((val, i) => ({ id: `d${i}`, val, selected: false }));

// [2,3,4,6] holds no 1, no 5 and no triple — a bust against any ordinary card.
const BUSTING_VALS = [2, 3, 4, 6];

describe('deriveRestoredTurn', () => {
  it('derives a fresh turn when nothing was cached', () => {
    const r = deriveRestoredTurn({ restored: null, currentCard: '300', ruleset: 'modernized' });

    expect(r.summary).toBeNull();
    expect(r.busted).toBe(false);
    expect(r.bankedDecision).toBe(false);
    expect(r.midDraw).toBe(false);
    expect(r.hasRolled).toBe(false);
    expect(r.currentRoll).toEqual([]);
    expect(r.initialChain).toEqual({
      cards: [{ card: '300', completed: false }],
      tuttoCount: 0,
      plusMinusScores: [],
      ended: 'banked',
      forfeitedScore: undefined,
    });
  });

  it('restores a recorded bust straight into its lost summary', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ busted: true, turnScore: 450, currentRoll: dice(...BUSTING_VALS) }),
      currentCard: '300',
      ruleset: 'modernized',
    });

    expect(r.summary).toEqual({ won: false, score: 0, isTutto: false });
    expect(r.busted).toBe(true);
    expect(r.initialChain.ended).toBe('null');
    expect(r.initialChain.forfeitedScore).toBe(450);
  });

  it('banks a Feuerwerk bust that had points on it, like the live null does', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ busted: true, turnScore: 700 }),
      currentCard: 'Feuerwerk',
      ruleset: 'modernized',
    });

    expect(r.summary).toEqual({ won: true, score: 700, isTutto: false });
    expect(r.initialChain.ended).toBe('banked');
    expect(r.initialChain.forfeitedScore).toBeUndefined();
  });

  it('marks the last chain card completed when a classic Feuerwerk null banks it', () => {
    // The null is how a Feuerwerk ENDS in classic, so the card WAS completed —
    // which is exactly what the server records for the same chain (see
    // feuerwerkBanked -> lastCompleted in server/turnTimers.ts). Restoring it
    // as uncompleted would commit a chain the server disagrees with.
    const r = deriveRestoredTurn({
      restored: snapshot({
        busted: true, turnScore: 1500,
        cardsThisTurn: ['300', 'Feuerwerk'], chainTuttoCount: 1,
      }),
      currentCard: 'Feuerwerk',
      ruleset: 'classic',
    });

    expect(r.initialChain.ended).toBe('banked');
    expect(r.initialChain.cards).toEqual([
      { card: '300', completed: true },
      { card: 'Feuerwerk', completed: true },
    ]);
  });

  it('re-derives the bust for a mid-tumble snapshot whose verdict was never written', () => {
    // rollingDiceIds present = finalizeRoll never ran; the dice themselves bust.
    const r = deriveRestoredTurn({
      restored: snapshot({ currentRoll: dice(...BUSTING_VALS), rollingDiceIds: ['d0'] }),
      currentCard: '300',
      ruleset: 'modernized',
    });

    expect(r.busted).toBe(true);
    expect(r.summary).toEqual({ won: false, score: 0, isTutto: false });
  });

  it('resumes a mid-tumble scoring roll as a playable table', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ currentRoll: dice(1, 5, 3), rollingDiceIds: ['d0'] }),
      currentCard: '300',
      ruleset: 'modernized',
    });

    expect(r.summary).toBeNull();
    expect(r.busted).toBe(false);
    expect(r.hasRolled).toBe(true);
  });

  it('trusts a settled snapshot: no rollingDiceIds means the roll was already judged', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ currentRoll: dice(...BUSTING_VALS) }),
      currentCard: '300',
      ruleset: 'modernized',
    });

    expect(r.busted).toBe(false);
    expect(r.summary).toBeNull();
  });

  it('re-applies classic Feuerwerk\'s forced keep to an unresolved scoring roll', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ currentRoll: dice(1, 2, 2, 5), rollingDiceIds: ['d0'] }),
      currentCard: 'Feuerwerk',
      ruleset: 'classic',
    });

    expect(r.currentRoll.map(d => ({ val: d.val, selected: d.selected }))).toEqual([
      { val: 1, selected: true },
      { val: 2, selected: false },
      { val: 2, selected: false },
      { val: 5, selected: true },
    ]);
  });

  it('restores a classic all-six-kept snapshot into its banked tutto summary', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({
        keptDice: dice(1, 1, 1, 5, 5, 5),
        turnScore: 1300,
        cardsThisTurn: ['300', 'x2'],
      }),
      currentCard: 'x2',
      ruleset: 'classic',
    });

    expect(r.summary).toEqual({ won: true, score: 1300, isTutto: true });
    // The tutto completed the chain's last card; earlier cards are completed
    // by definition.
    expect(r.initialChain.cards).toEqual([
      { card: '300', completed: true },
      { card: 'x2', completed: true },
    ]);
  });

  it('restores a Stop & Score decision into its banked summary, not a rollable table', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ stopped: true, turnScore: 350, keptDice: dice(1, 5) }),
      currentCard: '300',
      ruleset: 'modernized',
    });

    expect(r.summary).toEqual({ won: true, score: 350, isTutto: false });
    expect(r.bankedDecision).toBe(true);
    expect(r.busted).toBe(false);
  });

  it('restores a classic reload under a drawn Stop card into the forfeit summary', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ turnScore: 900, cardsThisTurn: ['300', 'Stop'] }),
      currentCard: 'Stop',
      ruleset: 'classic',
    });

    expect(r.summary).toEqual({ won: false, score: 0, isTutto: false, stoppedByCard: true });
    expect(r.initialChain.ended).toBe('stopCard');
    expect(r.initialChain.forfeitedScore).toBe(900);
  });

  it('flags an empty undecided table as a mid-draw resume that must re-roll', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ turnScore: 600, cardsThisTurn: ['300', 'x2'], chainTuttoCount: 1 }),
      currentCard: 'x2',
      ruleset: 'classic',
    });

    expect(r.midDraw).toBe(true);
    expect(r.hasRolled).toBe(false);
    expect(r.summary).toBeNull();
    expect(r.initialChain.tuttoCount).toBe(1);
  });

  it('lets a bust win over an all-six-kept tutto when both are in the snapshot', () => {
    const r = deriveRestoredTurn({
      restored: snapshot({ busted: true, keptDice: dice(1, 1, 1, 5, 5, 5), turnScore: 800 }),
      currentCard: '300',
      ruleset: 'classic',
    });

    expect(r.summary).toEqual({ won: false, score: 0, isTutto: false });
  });
});

describe('readRestorableTurn', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const save = (over: Partial<DiceSnapshot>) =>
    localStorage.setItem(DICE_TURN_STATE_KEY, JSON.stringify(snapshot(over)));

  it('returns the cached snapshot when the turn key matches', () => {
    save({ turnScore: 300, turnKey: 'room:1:0:300:modernized' });

    expect(readRestorableTurn('room:1:0:300:modernized')?.turnScore).toBe(300);
  });

  it('drops and evicts a snapshot stamped for a different turn', () => {
    save({ turnScore: 300, turnKey: 'room:1:0:300:modernized' });

    expect(readRestorableTurn('room:2:1:x2:modernized')).toBeNull();
    // Evicted, not just skipped — the stale entry must not resurface later.
    expect(localStorage.getItem(DICE_TURN_STATE_KEY)).toBeNull();
  });

  it('restores unconditionally when the caller passes no turn key', () => {
    save({ turnScore: 300, turnKey: 'whatever' });

    expect(readRestorableTurn(undefined)?.turnScore).toBe(300);
  });

  it('returns null when nothing was cached', () => {
    expect(readRestorableTurn('any')).toBeNull();
  });
});
