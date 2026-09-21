import { MAX_CHAIN_CARDS, type DiceSnapshot, type TurnSummary } from '../src/types';
import {
  isSnapshotDie, isRolledDie, isKniffelProgressEntry, isRollingDiceIdList,
  isChainCard, isChainCounter, isChainScoreList, isDeductedAmountList, isTurnCardList, isTurnEnd,
  TOTAL_DICE,
} from '../src/utils/turnShapes';
import { MAX_PLAYER_NAME_LENGTH, MAX_SCORE_MAGNITUDE } from '../src/utils/configValidation';
import { isTurnCardOutcomeList, copyTurnCardOutcomes } from '../src/utils/turnOutcomes';

const isNonNegativeBoundedNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE;

const isPlusMinusScoreList = (v: unknown): v is number[] =>
  isChainScoreList(v) && v.every(n => n <= MAX_SCORE_MAGNITUDE);

const isBoundedDeductedAmountList = (amounts: unknown, names: unknown): boolean =>
  isDeductedAmountList(amounts, names) && amounts.every(n => n <= MAX_SCORE_MAGNITUDE);

export const isValidDiceSnapshot = (v: unknown): v is DiceSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isNonNegativeBoundedNumber(s.turnScore)) return false;
  if (!isChainCounter(s.tuttosThisTurn)) return false;
  if (!(Array.isArray(s.keptDice) && s.keptDice.length <= TOTAL_DICE && s.keptDice.every(isSnapshotDie))) return false;
  if (!(Array.isArray(s.currentRoll) && s.currentRoll.length <= TOTAL_DICE && s.currentRoll.every(isRolledDie))) return false;
  if (!(Array.isArray(s.kniffelProgress) && s.kniffelProgress.length <= TOTAL_DICE && s.kniffelProgress.every(isKniffelProgressEntry))) return false;
  if (s.busted !== undefined && typeof s.busted !== 'boolean') return false;
  if (s.stopped !== undefined && typeof s.stopped !== 'boolean') return false;
  if (s.rollingDiceIds !== undefined && !isRollingDiceIdList(s.rollingDiceIds)) return false;
  if (s.cardsThisTurn !== undefined) {
    if (!Array.isArray(s.cardsThisTurn) || s.cardsThisTurn.length > MAX_CHAIN_CARDS) return false;
    if (!s.cardsThisTurn.every(isChainCard)) return false;
  }
  if (s.plusMinusScores !== undefined && !isPlusMinusScoreList(s.plusMinusScores)) return false;
  if (s.chainTuttoCount !== undefined && !isChainCounter(s.chainTuttoCount)) return false;
  if (s.lastCardCompleted !== undefined && typeof s.lastCardCompleted !== 'boolean') return false;
  if (s.cardOutcomes !== undefined && !isTurnCardOutcomeList(s.cardOutcomes)) return false;
  return true;
};

export const sanitizeDiceSnapshot = (v: DiceSnapshot): DiceSnapshot => {
  const clean: DiceSnapshot = {
    turnScore: v.turnScore,
    keptDice: v.keptDice.map(d => ({ id: d.id, val: d.val })),
    currentRoll: v.currentRoll.map(d => ({ id: d.id, val: d.val, selected: d.selected })),
    kniffelProgress: [...v.kniffelProgress],
    tuttosThisTurn: v.tuttosThisTurn,
  };
  if (v.busted) clean.busted = true;
  if (v.stopped) clean.stopped = true;
  if (v.rollingDiceIds) clean.rollingDiceIds = [...v.rollingDiceIds];
  if (v.cardsThisTurn) clean.cardsThisTurn = [...v.cardsThisTurn];
  if (v.plusMinusScores !== undefined) clean.plusMinusScores = [...v.plusMinusScores];
  if (v.chainTuttoCount !== undefined) clean.chainTuttoCount = v.chainTuttoCount;
  if (v.lastCardCompleted) clean.lastCardCompleted = true;
  if (v.cardOutcomes) clean.cardOutcomes = copyTurnCardOutcomes(v.cardOutcomes);
  return clean;
};

export const isValidTurnSummary = (v: unknown): v is TurnSummary => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isTurnCardList(s.cards)) return false;
  if (!isChainCounter(s.tuttoCount)) return false;
  if (!isPlusMinusScoreList(s.plusMinusScores)) return false;
  if (!isTurnEnd(s.ended)) return false;
  if (s.outcomes !== undefined && !isTurnCardOutcomeList(s.outcomes)) return false;
  if (s.forfeitedScore !== undefined &&
      !(typeof s.forfeitedScore === 'number' && Number.isFinite(s.forfeitedScore) && s.forfeitedScore >= 0 && s.forfeitedScore <= MAX_SCORE_MAGNITUDE)) return false;
  const isRecordOrNull = (v2: unknown): boolean =>
    v2 === null || (typeof v2 === 'number' && Number.isFinite(v2) && v2 >= 0 && v2 <= MAX_SCORE_MAGNITUDE);
  if (s.prevMostCardsInTurn !== undefined && !isRecordOrNull(s.prevMostCardsInTurn)) return false;
  if (s.prevHighestForfeitedTurnScore !== undefined && !isRecordOrNull(s.prevHighestForfeitedTurnScore)) return false;
  if (s.deductedPlayers !== undefined) {
    if (!Array.isArray(s.deductedPlayers) || s.deductedPlayers.length > MAX_CHAIN_CARDS) return false;
    if (!s.deductedPlayers.every(n => typeof n === 'string' && n.length > 0 && n.length <= MAX_PLAYER_NAME_LENGTH)) return false;
  }
  if (s.deductedAmounts !== undefined && !isBoundedDeductedAmountList(s.deductedAmounts, s.deductedPlayers)) return false;
  return true;
};
