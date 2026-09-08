/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { coachHint, type CoachHintInput } from './coachHint';
import { DEFAULT_INITIAL_CARDS } from './configValidation';
import { KNIFFEL_SCORE } from './coreGameEngine';
import { MAX_CHAIN_CARDS, type CardType } from '../types';

const input = (overrides: Partial<CoachHintInput> = {}): CoachHintInput => ({
  rollVals: [1, 5, 2, 2, 3, 4],
  keptCount: 0,
  turnScore: 0,
  currentCard: '200' as CardType,
  ruleset: 'modernized',
  kniffelProgress: [],
  standings: { myScore: 0, leaderScore: 0, winningScore: 6000 },
  deck: DEFAULT_INITIAL_CARDS,
  canDraw: false,
  chainCardCount: 0,
  tuttosThisTurn: 0,
  selectedIndices: [],
  isSelectionLocked: false,
  ...overrides,
});

describe('coachHint', () => {
  // The review's blocker: DiceGame's own availability booleans are all false
  // on a freshly landed roll (every die lands unselected), so a hint built
  // from the PLAYER's selection would never show at the moment it is
  // promised. The coach must derive availability from Otto's own pick
  // instead — this table's advice must be there with nothing tapped yet.
  it('advises on a fresh six-dice table although nothing is selected', () => {
    // Keeping the lone 1 leaves five dice; the bank is 100 (mirrors
    // botStrategies.test.ts's "rolls a full table of dice on a small bank").
    const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [] }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('roll');
    expect(hint!.keep).toEqual([1]);
  });

  it('advises stopping a 300-plus bank with few dice left', () => {
    // Four kept, the 5 makes the bank 350 and leaves one die: rolling it is
    // worth (1/3) * (350 + 75) = 142, well under the bank.
    const hint = coachHint(input({ keptCount: 4, rollVals: [5, 3], turnScore: 300 }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('stop');
    expect(hint!.bank).toBe(350);
  });

  it('advises drawing a classic tutto whose chain is still cheap to lose into the standard deck', () => {
    // Five kept on a 200 total, the sixth a 5: 250 plus the card's 200 = 450.
    const hint = coachHint(input({
      ruleset: 'classic', canDraw: true,
      keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: 0,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('draw');
    expect(hint!.bank).toBe(450);
  });

  it('reads the deck before advising a draw: never into nothing but Stop cards', () => {
    const hint = coachHint(input({
      ruleset: 'classic', canDraw: true, deck: { Stop: 4 },
      keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: 0,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('stop');
  });

  it('will not advise drawing past MAX_CHAIN_CARDS — the panel refuses it too', () => {
    const hint = coachHint(input({
      ruleset: 'classic', canDraw: true,
      keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: MAX_CHAIN_CARDS,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).not.toBe('draw');
    expect(hint!.action).toBe('stop');
  });

  it('never counts Plus/Minus dice in the bank', () => {
    // Otto would keep the 1 and the 5 (150 pts elsewhere), but Plus/Minus
    // pays only for completion — the dice are discarded outright.
    const hint = coachHint(input({ currentCard: 'Plus_Minus', turnScore: 100 }));
    expect(hint).not.toBeNull();
    expect(hint!.bank).toBe(100);
  });

  it('advises the lone 1 on a modernized Feuerwerk as well, with a bust risk and no bank to compare', () => {
    const hint = coachHint(input({ currentCard: 'Feuerwerk' }));
    expect(hint).not.toBeNull();
    expect(hint!.keep).toEqual([1]);
    expect(hint!.action).toBe('roll');
    expect(hint!.bustPercent).not.toBeNull();
    expect(hint!.rollValue).toBeNull();
  });

  it('advises keeping the 1 alone on a fresh 1-5 table, and flags a Select-all tap', () => {
    // 1 5 2 2 3 4 on a 200 card with nothing banked: the lone 1 with five
    // dice to roll is worth more than the 1 and the 5 with four
    // (feature_plan_otto_full_info.md), so Select all is exactly the tap the
    // hint is there to question.
    const hint = coachHint(input({ selectedIndices: [0, 1] }));
    expect(hint).not.toBeNull();
    expect(hint!.keep).toEqual([1]);
    expect(hint!.diceAfter).toBe(5);
    expect(hint!.action).toBe('roll');
    expect(hint!.selectionDiffers).toBe(true);
  });

  it('is trailing only when the leader is actually ahead', () => {
    // Mirrors botStrategies.test.ts's "takes more risk the further behind".
    const level = coachHint(input({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200, standings: { myScore: 0, leaderScore: 0, winningScore: 6000 } }));
    expect(level).not.toBeNull();
    expect(level!.action).toBe('stop');
    expect(level!.trailing).toBe(false);

    const behind = coachHint(input({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200, standings: { myScore: 0, leaderScore: 3000, winningScore: 6000 } }));
    expect(behind).not.toBeNull();
    expect(behind!.action).toBe('roll');
    expect(behind!.trailing).toBe(true);
  });

  describe('selectionDiffers', () => {
    it('is false with no selection on the table', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [] }));
      expect(hint!.selectionDiffers).toBe(false);
    });

    it('is false while the selection is locked (a forced Feuerwerk keep)', () => {
      // Index 1 (the 2) is not part of Otto's pick ([0], the 1) — it would
      // read as a mismatch if the lock did not suppress it.
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [1], isSelectionLocked: true }));
      expect(hint!.selectionDiffers).toBe(false);
    });

    it('is true when the player has tapped a different die than Otto would keep', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [1] }));
      expect(hint!.selectionDiffers).toBe(true);
    });

    it('is false when the tap already matches Otto\'s own pick', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [0] }));
      expect(hint!.selectionDiffers).toBe(false);
    });
  });

  it('is null on a table that has nothing to keep', () => {
    // No 1, no 5, no completed triple — busts under the default rules.
    expect(coachHint(input({ rollVals: [2, 3, 4, 6, 6, 4] }))).toBeNull();
  });

  // S-1: a completing classic Kniffel used to hint bank: 0 while the panel's
  // own running total showed 2000 (checkValidityAndScore scores a straight's
  // dice 0, and nothing else was paying the award).
  it('banks the card award on a completing classic Kniffel', () => {
    const hint = coachHint(input({
      ruleset: 'classic', currentCard: 'Kniffel', kniffelProgress: [1, 2, 3, 4, 5],
      keptCount: 5, rollVals: [6], turnScore: 0, canDraw: false,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.bank).toBe(KNIFFEL_SCORE);
    expect(hint!.action).toBe('stop');
  });

  // S-3: available.roll is false the moment the card is done (no roll button
  // on the panel), so the bust figures Otto's roll-or-stop arithmetic would
  // have produced must not be quoted for a roll that was never on offer.
  it('quotes no bust risk when rolling is not on offer', () => {
    const hint = coachHint(input({
      ruleset: 'classic', currentCard: 'Kniffel', kniffelProgress: [1, 2, 3, 4, 5],
      keptCount: 5, rollVals: [6], canDraw: false,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('stop');
    expect(hint!.bustPercent).toBeNull();
    expect(hint!.rollValue).toBeNull();
    expect(hint!.threshold).toBeNull();
  });

  it('still quotes the bust risk when a roll is on offer', () => {
    // Mirrors "advises on a fresh six-dice table": roll is offered, so the
    // figures behind the advice are still there to show.
    const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6] }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('roll');
    expect(hint!.bustPercent).not.toBeNull();
    expect(hint!.rollValue).not.toBeNull();
    expect(hint!.threshold).not.toBeNull();
  });

  /**
   * Otto may never quote an option the panel is not offering. Kniffel,
   * Plus/Minus and Kleeblatt withhold Stop until the card is complete
   * (SPECIAL_CARDS in diceTurnControls), and Feuerwerk never offers it at
   * all — so on any of them there is no bank for a roll to be measured
   * against, and the figures that comparison is made of must not be there
   * to print. Same rule as S-3 one step further: bustPercent is already
   * null when the ROLL is not on offer; these two are null when the BANK
   * is not.
   */
  describe('a bank the panel is not offering', () => {
    const noBank: Array<[string, Partial<CoachHintInput>]> = [
      ['a Kniffel still short of its straight', { currentCard: 'Kniffel', rollVals: [6, 5, 6, 2, 5, 1] }],
      ['a Plus/Minus still short of its table', { currentCard: 'Plus_Minus', rollVals: [1, 2, 2, 2, 6, 4] }],
      ['a Feuerwerk, which never banks mid-card', { currentCard: 'Feuerwerk', rollVals: [1, 2, 2, 2, 6, 4] }],
    ];

    it.each(noBank)('quotes no banking comparison on %s', (_label, overrides) => {
      const hint = coachHint(input({ ...overrides, turnScore: 300 }));
      expect(hint).not.toBeNull();
      expect(hint!.action).toBe('roll');
      expect(hint!.rollValue).toBeNull();
      expect(hint!.threshold).toBeNull();
      // The roll itself IS on offer, so its risk is still the player's to see.
      expect(hint!.bustPercent).not.toBeNull();
    });

    it.each(noBank)('never explains the risk it did not take on %s', (_label, overrides) => {
      // The trailing clause excuses rolling past a bank Otto could have
      // taken. With no bank on offer the roll was forced, and the excuse
      // reads as a decision nobody made.
      const hint = coachHint(input({
        ...overrides, turnScore: 300, standings: { myScore: 0, leaderScore: 3000, winningScore: 6000 },
      }));
      expect(hint!.trailing).toBe(false);
    });
  });

  /**
   * Kleeblatt's Stop button is not a bank in either of its two states: on the
   * first tutto it rolls the second one (deriveTurnControls' own
   * 'dice.roll_2nd_tutto'), and on the second it completes the card, which
   * wins the game outright and scores the turn 0 (resolveKleeblattWin in
   * coreGameEngine). Calling either one "bank 500" advises something that
   * cannot happen.
   */
  describe('stopMeans', () => {
    it('is a second tutto to roll on the first Kleeblatt tutto', () => {
      const hint = coachHint(input({
        currentCard: 'Kleeblatt', keptCount: 5, rollVals: [1], turnScore: 400, tuttosThisTurn: 0,
      }));
      expect(hint).not.toBeNull();
      expect(hint!.action).toBe('stop');
      expect(hint!.stopMeans).toBe('secondTutto');
    });

    it('is the game itself on the second Kleeblatt tutto', () => {
      const hint = coachHint(input({
        currentCard: 'Kleeblatt', keptCount: 5, rollVals: [1], turnScore: 400, tuttosThisTurn: 1,
      }));
      expect(hint).not.toBeNull();
      expect(hint!.action).toBe('stop');
      expect(hint!.stopMeans).toBe('winGame');
    });

    it('is a plain bank on every other card', () => {
      const hint = coachHint(input({ keptCount: 4, rollVals: [5, 3], turnScore: 300 }));
      expect(hint).not.toBeNull();
      expect(hint!.action).toBe('stop');
      expect(hint!.stopMeans).toBe('bank');
    });
  });

  it('excuses the extra risk only on the roll that risk actually bought', () => {
    // Behind, and rolling on (239) is worth less than the sure bank (300):
    // the appetite is the whole reason this is not a stop, so the clause
    // has something to explain.
    const bought = coachHint(input({
      keptCount: 3, rollVals: [1, 3, 4], turnScore: 200,
      standings: { myScore: 0, leaderScore: 3000, winningScore: 6000 },
    }));
    expect(bought!.action).toBe('roll');
    expect(bought!.trailing).toBe(true);

    // Behind by the same margin, but Otto banks anyway — with 650 in hand
    // the last die is worth 308 against a bank discounted to 325, so the
    // appetite changed nothing, and the clause would contradict the advice.
    const banked = coachHint(input({
      keptCount: 4, rollVals: [5, 3], turnScore: 600,
      standings: { myScore: 0, leaderScore: 3000, winningScore: 6000 },
    }));
    expect(banked!.action).toBe('stop');
    expect(banked!.trailing).toBe(false);
  });

  describe('last-seat endgame advice', () => {
    const endgame = { opponentScores: [5000] };

    it('names a bank that guarantees the win and hides ordinary comparison figures', () => {
      const hint = coachHint(input({
        rollVals: [1, 2, 2, 2, 3, 4],
        standings: { myScore: 5900, leaderScore: 5900, winningScore: 6000, endgame },
      }));

      expect(hint).toMatchObject({ action: 'stop', reason: 'bankWin', trailing: false });
      expect(hint!.rollValue).toBeNull();
      expect(hint!.threshold).toBeNull();
    });

    it('rolls when a reachable roll is the only way to avoid losing', () => {
      const hint = coachHint(input({
        rollVals: [1, 1, 1, 1, 2, 3],
        standings: { myScore: 4900, leaderScore: 6100, winningScore: 6000, endgame: { opponentScores: [6100] } },
      }));

      expect(hint).toMatchObject({ action: 'roll', reason: 'avoidLoss', trailing: false });
      expect(hint!.rollValue).toBeNull();
      expect(hint!.threshold).toBeNull();
    });

    it('draws when a reachable next card is the only way to avoid losing', () => {
      const hint = coachHint(input({
        ruleset: 'classic', canDraw: true, chainCardCount: 0,
        deck: { Stop: 99, Kniffel: 1 }, keptCount: 5, rollVals: [1], turnScore: 800,
        standings: { myScore: 4900, leaderScore: 6100, winningScore: 6000, endgame: { opponentScores: [6100] } },
      }));

      expect(hint).toMatchObject({ action: 'draw', reason: 'avoidLoss', trailing: false });
      expect(hint!.rollValue).toBeNull();
      expect(hint!.threshold).toBeNull();
    });

    it('keeps the old arithmetic when endgame context is absent', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 2, 2, 3, 4] }));

      expect(hint).not.toBeNull();
      expect(hint!.reason).toBeUndefined();
      expect(hint!.rollValue).not.toBeNull();
      expect(hint!.threshold).not.toBeNull();
    });

    it('replays pending classic Plus/Minus deductions before deciding a win', () => {
      const endgameInput = {
        ruleset: 'classic' as const,
        currentCard: '200' as CardType,
        keptCount: 5,
        rollVals: [1],
        turnScore: 2300,
        standings: { myScore: 3900, leaderScore: 6500, winningScore: 6000, endgame: { opponentScores: [6500, 6200] } },
        plusMinusScores: [0, 1000],
      };
      const withPending = coachHint(input(endgameInput));
      const withoutPending = coachHint(input({ ...endgameInput, plusMinusScores: [] }));

      expect(withPending).toMatchObject({ action: 'stop', reason: 'bankWin' });
      expect(withoutPending?.reason).toBeUndefined();
    });
  });

  // S-5: CoachHintInput no longer carries isClassic at all — coachHint must
  // derive it from ruleset on its own (a classic tutto still offers the draw
  // its panel offers, with no isClassic field anywhere in this input).
  it('derives isClassic from ruleset alone', () => {
    const hint = coachHint(input({
      ruleset: 'classic', canDraw: true, keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: 0,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('draw');
  });
});
