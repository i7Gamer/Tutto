/**
 * Shape checks for the dice snapshot and the classic turn summary.
 *
 * Three boundaries validate these same shapes: the localStorage dice cache
 * (diceTurnState.ts), the physical-turn cache and the local save
 * (usePhysicalChain.ts, store/persistence.ts), and pushed room state
 * (server/pushValidation.ts). Each used to carry its own hand-written copy —
 * five parallel die predicates, the {card, completed} entry three times, the
 * TurnEnd values twice — under comments calling them "mirrors", which named the
 * coupling without sharing it. A shape added to types.ts had to be remembered
 * in up to three places, and forgetting one silently rejected valid data there.
 *
 * These are SHAPE only. The untrusted boundary layers its own additional
 * bounds on top (score magnitudes, name lengths, array sizes tied to the
 * roster) — see server/pushValidation.ts. What is genuinely common lives here;
 * what is genuinely stricter about the network stays there.
 */

import { MAX_CHAIN_CARDS, TURN_ENDS, type CardType, type SnapshotDie, type TurnCardPlayed, type TurnEnd } from '../types';
import { VALID_CARD_TYPES } from './configValidation';

/**
 * A die id only ever holds a uuidv4() (36 chars) — capped generously above that
 * so a plausible id always passes, while still bounding string size. Applied at
 * every boundary, not just the network one: an over-long id is corrupt wherever
 * it came from, and one rule is easier to trust than two.
 */
export const MAX_DICE_ID_LENGTH = 64;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

const isFaceValue = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 6;

export const isSnapshotDie = (v: unknown): v is SnapshotDie => {
  const d = asRecord(v);
  if (!d) return false;
  return typeof d.id === 'string' && d.id.length > 0 && d.id.length <= MAX_DICE_ID_LENGTH
    && isFaceValue(d.val);
};

export const isRolledDie = (v: unknown): v is SnapshotDie & { selected: boolean } =>
  isSnapshotDie(v) && typeof (v as unknown as Record<string, unknown>).selected === 'boolean';

export const isKniffelProgressEntry = (v: unknown): v is number => isFaceValue(v);

export const isChainCard = (v: unknown): v is CardType =>
  typeof v === 'string' && (VALID_CARD_TYPES as readonly string[]).includes(v);

/** A count of things that happened during one chain, bounded by the chain itself. */
export const isChainCounter = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CHAIN_CARDS;

/**
 * The running totals a chain's Plus/Minus cards resolved on — one per success,
 * bounded by the chain like the card list. Shape only: score magnitude is the
 * untrusted boundary's own rule (server/pushValidation.ts).
 */
export const isChainScoreList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length <= MAX_CHAIN_CARDS
  && v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);

export const isTurnCardPlayed = (v: unknown): v is TurnCardPlayed => {
  const entry = asRecord(v);
  if (!entry) return false;
  return isChainCard(entry.card) && typeof entry.completed === 'boolean';
};

export const isTurnEnd = (v: unknown): v is TurnEnd =>
  typeof v === 'string' && (TURN_ENDS as readonly string[]).includes(v);

/**
 * The cards of one chain: an array within the chain cap, every entry a valid
 * played card. Empty is allowed — callers that need at least one say so
 * themselves (the physical cache does; a turn summary does not).
 */
export const isTurnCardList = (v: unknown): v is TurnCardPlayed[] =>
  Array.isArray(v) && v.length <= MAX_CHAIN_CARDS && v.every(isTurnCardPlayed);
