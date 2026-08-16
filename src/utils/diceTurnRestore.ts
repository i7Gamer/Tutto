import { localStore } from './storage';
import { isBust } from './diceLogic';
import { withForcedFeuerwerkSelection } from './diceTurnControls';
import { parseSavedDiceState, DICE_TURN_STATE_KEY } from './diceTurnState';
import type { CardType, DiceSnapshot, Die, Ruleset, TurnCardPlayed, TurnEnd } from '../types';

/**
 * What to resume a dice turn into, derived from the snapshot diceTurnState.ts
 * cached. Pure interpretation, split out of DiceGame so its branches — and
 * they are subtle, every one a bug that shipped or nearly did — are directly
 * unit-testable instead of only reachable through a mounted component.
 */

/** The summary a restore lands on — same shape DiceSummary consumes. */
export interface RestoredSummary {
  won: boolean;
  score: number;
  isTutto?: boolean;
  // The chain was ended by a drawn Stop card (classic) — everything is lost.
  stoppedByCard?: boolean;
}

/** The classic chain a resumed turn continues, or the seed for a fresh one. */
export interface RestoredChain {
  cards: TurnCardPlayed[];
  tuttoCount: number;
  plusMinusScores: number[];
  ended: TurnEnd;
  forfeitedScore?: number;
}

export interface RestoredTurn {
  /**
   * The snapshot was taken between drawing a chain card and its first roll
   * (the reveal panel holds that window open for as long as the player takes
   * to dismiss it). Resuming it has to roll: restoring as-is hands back a
   * table with no dice on it and no button that would put any there.
   */
  midDraw: boolean;
  /** The roll to put back on the table, Feuerwerk's forced keep re-applied. */
  currentRoll: Die[];
  /** The decided summary to restore straight into, or null for a playable table. */
  summary: RestoredSummary | null;
  /** The restore is a bust — seeds bustState. */
  busted: boolean;
  /** The restore is a banked decision — seeds the stopped marker. */
  bankedDecision: boolean;
  hasRolled: boolean;
  initialChain: RestoredChain;
}

/**
 * The cached turn to resume into, or null to start fresh.
 *
 * A snapshot stamped for a different turn — e.g. the server's turn timer
 * advanced past this player while they were disconnected or backgrounded, so
 * their own client never got the chance to clear its cache entry — is dropped
 * rather than resumed into the new turn. turnKey is undefined for callers that
 * don't pass it (predating that prop), in which case restoration stays
 * unconditional as before.
 *
 * Evicting the stale entry here means this runs during the first render rather
 * than after it. That is safe to repeat, which is what StrictMode's second
 * invocation of a lazy initializer does: the second pass reads no entry and
 * removes nothing.
 */
export const readRestorableTurn = (turnKey: string | undefined): DiceSnapshot | null => {
  const restored = parseSavedDiceState(localStore.read(DICE_TURN_STATE_KEY));
  if (!restored) return null;
  if (turnKey !== undefined && restored.turnKey !== turnKey) {
    localStore.remove(DICE_TURN_STATE_KEY);
    return null;
  }
  return restored;
};

export const deriveRestoredTurn = ({ restored, currentCard, ruleset }: {
  restored: DiceSnapshot | null;
  currentCard: CardType | null;
  ruleset: Ruleset;
}): RestoredTurn => {
  const isClassic = ruleset === 'classic';

  // A snapshot cached while the dice were still tumbling carries no verdict:
  // the live snapshot is debounced from the moment the roll starts, while
  // `busted` is written by finalizeRoll — the only place isBust ever runs —
  // once every die has settled. Restored as if it were a settled board, a
  // busting roll would stay unjudged forever: no bust, no auto-roll, and the
  // dice panel is deliberately non-dismissible, so nothing could end the turn.
  // Re-derive what finalizeRoll would have decided from the dice the snapshot
  // does carry, rather than trusting a flag that was never written.
  const rollValues = restored?.currentRoll.map(d => d.val) ?? [];
  const unresolvedRoll = !!restored && !restored.busted && !restored.stopped
    && (restored.rollingDiceIds?.length ?? 0) > 0 && rollValues.length > 0;
  const rollBusts = unresolvedRoll
    && isBust(rollValues, currentCard, restored?.kniffelProgress ?? [], ruleset);

  // A bust is restored straight into its summary: the turn is already over and
  // what is left to show is its outcome.
  const bust: RestoredSummary | null = restored && (restored.busted || rollBusts)
    ? {
      won: currentCard === 'Feuerwerk' && restored.turnScore > 0,
      score: currentCard === 'Feuerwerk' ? restored.turnScore : 0,
      isTutto: false,
    }
    : null;

  // A classic snapshot with all six dice put aside is a completed tutto that
  // was banked — restore into its summary, not into a dice table with nothing
  // left to select. (Banking marks `stopped` too, so this mostly catches
  // caches written before it did.)
  const tutto: RestoredSummary | null = !bust && isClassic && restored && restored.keptDice.length === 6
    ? { won: true, score: restored.turnScore, isTutto: true }
    : null;

  // A classic chain had just drawn a Stop card when the app reloaded (the
  // turn key carries the current card, so a matching restore under 'Stop'
  // can only be that forfeit summary) — restore into it, not into a rollable
  // dice table for a card that allows no rolling.
  const stoppedByCard: RestoredSummary | null = !bust && !tutto && isClassic && restored && currentCard === 'Stop'
    ? { won: false, score: 0, isTutto: false, stoppedByCard: true }
    : null;

  // A banked decision (Stop & Score, or a modernized turn-ending tutto —
  // both commit with the stopped marker) — restore into its success summary,
  // never a dice table where the decision could be rolled back into Roll
  // Again. All six dice put aside is what a tutto IS, so the kept-dice count
  // recovers the "Tutto!" headline.
  const banked: RestoredSummary | null = !bust && !tutto && !stoppedByCard && restored?.stopped
    ? { won: true, score: restored.turnScore, isTutto: restored.keptDice.length === 6 }
    : null;

  // See RestoredTurn.midDraw above: an empty table that is neither busted nor
  // banked was snapshotted between drawing a chain card and its first roll.
  const midDraw = !!restored && !bust && !tutto && !stoppedByCard && !banked
    && restored.keptDice.length === 0 && restored.currentRoll.length === 0;

  // finalizeRoll's other branch, for the same never-finalized snapshot: an
  // unresolved classic Feuerwerk roll comes back with nothing selected, and
  // its selection cannot be made by hand (toggleDie is a no-op for that card),
  // so the board would have no actionable button either.
  const currentRoll = unresolvedRoll && !rollBusts && isClassic && currentCard === 'Feuerwerk'
    ? withForcedFeuerwerkSelection(restored?.currentRoll ?? [], ruleset)
    : restored?.currentRoll ?? [];

  // The classic chain this turn continues. Cards before the last are completed
  // by definition; the last one only by the tutto that banked it.
  const cardList = restored?.cardsThisTurn ?? (currentCard ? [currentCard] : []);
  const initialChain: RestoredChain = {
    cards: cardList.map((card, i) => ({ card, completed: i < cardList.length - 1 || (i === cardList.length - 1 && !!tutto) })),
    tuttoCount: restored?.chainTuttoCount ?? 0,
    plusMinusScores: restored?.plusMinusScores ?? [],
    ended: stoppedByCard ? 'stopCard' : bust ? (bust.won ? 'banked' : 'null') : 'banked',
    forfeitedScore: (bust && !bust.won) || stoppedByCard ? restored?.turnScore : undefined,
  };

  return {
    midDraw,
    currentRoll,
    summary: bust ?? tutto ?? stoppedByCard ?? banked,
    busted: bust !== null,
    bankedDecision: banked !== null,
    hasRolled: !!restored && !midDraw,
    initialChain,
  };
};
