import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { describeLandedRoll } from '../utils/rollAnnouncement';
import { formatList } from '../utils/formatList';
import type { CardType, Ruleset } from '../types';

export interface UseRollAnnouncementOptions {
  hasRolled: boolean;
  isRolling: boolean;
  bustState: boolean;
  rollVals: number[];
  currentCard: CardType | null;
  kniffelProgress: number[];
  ruleset: Ruleset;
  // Dice already kept on the table before this roll.
  keptCount: number;
  turnScore: number;
  // DiceGame turns this into { key, values, seq } state for RollAnnouncer —
  // a real i18n key plus its interpolation object, the same shape
  // useTurnAnnouncement's addToast is handed a plain string with.
  announce: (key: string, values: Record<string, unknown>) => void;
}

// Cards whose dice carry no value of their own (diceLogic.ts's
// checkValidityAndScore scores Kniffel's straight as a phantom 0, and
// DiceGame's FIXED_CARD_AWARD/countsDicePoints discard Plus/Minus's dice
// outright) — describeLandedRoll returns score: null for these, and the
// announcement uses the count-only wording (rollLandedFixed).
const FIXED_SCORE_CARDS: ReadonlySet<CardType> = new Set(['Kniffel', 'Plus_Minus']);

/**
 * Speaks each landed roll exactly once, through `announce` — never during
 * the tumble, never per die, and silent on a busting roll (CurrentRollBoard's
 * own role="alert" banner already speaks for that).
 *
 * Fires on the settle edge: previous isRolling true, current false, with
 * hasRolled && !bustState — the same edge-detection useTurnAnnouncement runs
 * for isMyTurn, tracked in a ref the same way. A resumed turn seeds
 * hasRolled but DiceGame never restores isRolling to true, so there is no
 * false-to-true edge on mount and a resumed turn announces nothing; that is
 * intentional, not a gap to close later.
 *
 * The values read at that edge come from a ref updated every render, not
 * from this effect's own dependency list. currentRoll (and so rollVals) gets
 * a new array identity on every die TAP, not only on a fresh roll — a
 * dependency on it here would re-run describeLandedRoll's enumeration once
 * per tap instead of once per landing.
 */
export const useRollAnnouncement = ({
  hasRolled, isRolling, bustState, rollVals, currentCard, kniffelProgress, ruleset,
  keptCount, turnScore, announce,
}: UseRollAnnouncementOptions): void => {
  const { t, i18n } = useTranslation();

  const latestRef = useRef({
    rollVals, currentCard, kniffelProgress, ruleset, keptCount, turnScore, announce, t,
    language: i18n.language,
  });
  useEffect(() => {
    latestRef.current = {
      rollVals, currentCard, kniffelProgress, ruleset, keptCount, turnScore, announce, t,
      language: i18n.language,
    };
  });

  const wasRollingRef = useRef(isRolling);
  useEffect(() => {
    const settled = wasRollingRef.current && !isRolling;
    wasRollingRef.current = isRolling;
    if (!settled || !hasRolled || bustState) return;

    const {
      rollVals: latestRollVals, currentCard: latestCard, kniffelProgress: latestProgress,
      ruleset: latestRuleset, keptCount: latestKeptCount, turnScore: latestTurnScore,
      announce: latestAnnounce, t: latestT, language,
    } = latestRef.current;

    const { scoringCount, score, completesTutto } = describeLandedRoll({
      rollVals: latestRollVals,
      currentCard: latestCard,
      kniffelProgress: latestProgress,
      ruleset: latestRuleset,
      keptCount: latestKeptCount,
    });

    // Pre-translated fragments folded into the base sentence's interpolation
    // values — the same pattern HistoryLog.tsx uses for its `deducted`
    // clause (history.deductedEntry folded into history.chainSuccessDeducted)
    // — so a single announce() call carries the whole composed message
    // instead of RollAnnouncer firing a second live-region update.
    const completesSuffix = completesTutto ? ` ${latestT('dice.announce.completesCard')}` : '';
    // Gated on the score, not just the count: a tutto's ROLL_ON_COMMITTED and
    // a classic CHAIN_DRAWN both reset keptDice to [] while turnScore carries
    // the running total forward onto the fresh table, so a count-only gate
    // dropped the clause exactly when the most is at stake.
    const turnSoFarSuffix = latestKeptCount > 0 || latestTurnScore > 0
      ? ` ${latestT('dice.announce.turnSoFar', { kept: latestKeptCount, turnScore: latestTurnScore })}`
      : '';

    const key = latestCard !== null && FIXED_SCORE_CARDS.has(latestCard)
      ? 'dice.announce.rollLandedFixed'
      : 'dice.announce.rollLanded';

    latestAnnounce(key, {
      values: formatList(latestRollVals, language),
      count: scoringCount,
      score,
      completesSuffix,
      turnSoFarSuffix,
    });
    // Every value this effect reads comes from latestRef (updated by the
    // unconditional effect above on every render) rather than from the
    // dependency list — see the doc comment above for why.
  }, [isRolling, hasRolled, bustState]);
};
