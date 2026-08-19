import { localStore } from '../utils/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildTurnKey, PHYSICAL_TURN_STATE_KEY } from '../utils/diceTurnState';
import { MAX_CHAIN_CARDS } from '../types';
import { isChainScoreList, isTurnCardList } from '../utils/turnShapes';
import type { CardType, Ruleset, TurnCardPlayed, TurnEnd, TurnSummary } from '../types';

/*
 * The PHYSICAL_TURN_STATE_KEY cache — the counterpart of DICE_TURN_STATE_KEY
 * for digital turns. With real dice the app owns only the card draws and the
 * running total the player typed, so that is exactly what must survive a
 * reload or reconnect: the chain's cards, the Plus/Minus successes, whether
 * the bank-or-draw choice was open, and the score input. Stamped with the
 * same turn key the digital cache uses (latest drawn card included), so a
 * stale chain can never resume into a different turn; game-lifecycle
 * boundaries clear it via clearTurnCaches (see diceTurnState.ts).
 */

interface PhysicalChainState {
  cards: TurnCardPlayed[];
  // See TurnSummary.plusMinusScores: the running total the player held as each
  // Plus/Minus was answered Yes. With real dice that total is what they have
  // typed so far, which Game keeps current across the whole chain.
  plusMinusScores: number[];
}

interface PhysicalChainCache extends PhysicalChainState {
  turnKey: string;
  awaitingChoice: boolean;
  scoreInput: string;
}

// The running total is digits the player typed — anything longer than a real
// Tutto score (or not digits at all) is a corrupted entry, not a score.
const MAX_SCORE_INPUT_LENGTH = 7;
const SCORE_INPUT_SHAPE = /^\d*$/;

// The chain fields are load-bearing (undo, per-card counters) and validated
// all-or-nothing; the score input is merely retypable, so it is sanitized
// field-wise in readPhysicalChainCache instead of taking the chain down.
type PhysicalChainCacheShape = Omit<PhysicalChainCache, 'scoreInput'> & { scoreInput?: unknown };

const isPlausibleScoreInput = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_SCORE_INPUT_LENGTH && SCORE_INPUT_SHAPE.test(v);

/**
 * How many tuttos a card is known to have taken to complete, for the floor
 * below. A Kleeblatt needs two; Feuerwerk needs none — that card is completed
 * by BANKING, which happens on the null that ends it. Every other card
 * completes on exactly one tutto and takes the default.
 */
const TUTTOS_PER_COMPLETION: Partial<Record<CardType, number>> = {
  Kleeblatt: 2,
  Feuerwerk: 0,
};
const DEFAULT_TUTTOS_PER_COMPLETION = 1;

const isPlausibleCache = (v: unknown): v is PhysicalChainCacheShape => {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.turnKey !== 'string') return false;
  // The shared shape check allows an empty list; an entry with no cards is not
  // a turn worth resuming, so that one is this cache's own rule.
  if (!isTurnCardList(c.cards) || c.cards.length === 0) return false;
  if (!isChainScoreList(c.plusMinusScores)) return false;
  if (typeof c.awaitingChoice !== 'boolean') return false;
  return true;
};

/**
 * Reads the cached physical turn if it belongs to exactly the given turn key;
 * anything else (malformed chain, or stamped for another turn) is evicted so
 * it can never resurface — the same contract as readRestorableTurn in
 * diceTurnRestore.ts.
 * A garbled score input alone falls back to empty rather than evicting the
 * chain with it. Exported so Game.tsx can seed its scoreInput state from the
 * same entry the hook restores the chain from.
 */
export const readPhysicalChainCache = (turnKey: string): PhysicalChainCache | null => {
  try {
    const parsed: unknown = JSON.parse(localStore.read(PHYSICAL_TURN_STATE_KEY) ?? 'null');
    if (!isPlausibleCache(parsed) || parsed.turnKey !== turnKey) {
      localStore.remove(PHYSICAL_TURN_STATE_KEY);
      return null;
    }
    return {
      turnKey: parsed.turnKey,
      cards: parsed.cards,
      plusMinusScores: parsed.plusMinusScores,
      awaitingChoice: parsed.awaitingChoice,
      scoreInput: isPlausibleScoreInput(parsed.scoreInput) ? parsed.scoreInput : '',
    };
  } catch {
    localStore.remove(PHYSICAL_TURN_STATE_KEY);
    return null;
  }
};

interface UsePhysicalChainArgs {
  // Classic rules with physical dice — everything is inert otherwise: nothing
  // restores, nothing is written.
  enabled: boolean;
  roomId: string | null;
  round: number;
  currentPlayerIndex: number | null;
  currentCard: CardType | null;
  ruleset: Ruleset;
  // Persisted alongside the chain so the typed running total survives too.
  scoreInput: string;
}

/**
 * The classic physical-dice chain: with real dice the app owns only the card
 * draws, so Game.tsx records the chain here — which cards were played, how
 * many Plus/Minus succeeded, and whether a special card's Yes is waiting for
 * the bank-or-draw decision. The chain lives in a ref (nothing renders its
 * contents) and every change is written through to localStorage under the
 * current turn key, so a reload or reconnect resumes the turn exactly where
 * it stood instead of forgetting everything but the current card.
 */
export const usePhysicalChain = ({ enabled, roomId, round, currentPlayerIndex, currentCard, ruleset, scoreInput }: UsePhysicalChainArgs) => {
  const currentTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard, ruleset);

  // Read once, during the first render — the same mount-time restore pattern
  // as DiceGame's digital cache.
  const [restored] = useState(() => (enabled ? readPhysicalChainCache(currentTurnKey) : null));
  const chainRef = useRef<PhysicalChainState | null>(
    restored ? { cards: restored.cards, plusMinusScores: restored.plusMinusScores } : null,
  );
  const [awaitingChoice, setAwaitingChoice] = useState(restored?.awaitingChoice ?? false);

  // Reset when the turn slot changes — a leftover chain from the previous
  // turn must never leak into the next one. The choice flag resets at render
  // time (stale-render correction pattern); the ref and the cache clear in an
  // effect, gated so the mount run cannot wipe what was just restored.
  const turnSlot = `${round}:${currentPlayerIndex}`;
  const [prevTurnSlot, setPrevTurnSlot] = useState(turnSlot);
  if (turnSlot !== prevTurnSlot) {
    setPrevTurnSlot(turnSlot);
    if (awaitingChoice) setAwaitingChoice(false);
  }
  const slotRef = useRef(turnSlot);
  useEffect(() => {
    if (slotRef.current === turnSlot) return;
    slotRef.current = turnSlot;
    chainRef.current = null;
    localStore.remove(PHYSICAL_TURN_STATE_KEY);
  }, [turnSlot]);

  // Read through refs so the mutators stay referentially stable across
  // keystrokes and card changes (the Stop-card auto-continue effect depends
  // on them); callbacks and effects always see the current values.
  const scoreInputRef = useRef(scoreInput);
  useEffect(() => { scoreInputRef.current = scoreInput; });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; });

  const currentCardRef = useRef(currentCard);
  useEffect(() => { currentCardRef.current = currentCard; });

  // The chain so far, or — before any chain action this turn — just the
  // current card, still unresolved.
  const chainOrCurrentCard = useCallback((): PhysicalChainState => (
    chainRef.current ?? {
      cards: currentCardRef.current ? [{ card: currentCardRef.current, completed: false }] : [],
      plusMinusScores: [],
    }
  ), []);

  const writeCache = useCallback((turnKey: string, awaiting: boolean) => {
    if (!enabledRef.current) return;
    // Before any chain action the entry still records the unresolved current
    // card, so a total typed on the FIRST card survives a reload too.
    const chain = chainOrCurrentCard();
    if (chain.cards.length === 0) return;
    const cache: PhysicalChainCache = {
      turnKey,
      cards: chain.cards,
      plusMinusScores: chain.plusMinusScores,
      awaitingChoice: awaiting,
      scoreInput: scoreInputRef.current,
    };
    localStore.write(PHYSICAL_TURN_STATE_KEY, JSON.stringify(cache));
  }, [chainOrCurrentCard]);

  // Keeps the cached entry in step with what the player types between the
  // explicit writes below (the mutators write immediately because a draw of
  // the same card type changes neither state nor key, so no effect would run).
  useEffect(() => {
    if (!enabled) return;
    // No chain action and nothing typed = nothing worth keeping. Removing
    // (not just skipping) means a commit-then-cleared input leaves no
    // synthetic single-card entry behind.
    if (!chainRef.current && scoreInput === '') {
      localStore.remove(PHYSICAL_TURN_STATE_KEY);
      return;
    }
    writeCache(currentTurnKey, awaitingChoice);
  }, [enabled, currentTurnKey, awaitingChoice, scoreInput, writeCache]);

  // A special card's Yes: the card is completed (Plus/Minus also counts its
  // success) and the bank-or-draw choice opens. Does NOT commit the turn.
  const completeCurrentCard = useCallback((isPlusMinus: boolean) => {
    const source = chainOrCurrentCard();
    // The typed total is the chain's running score, and Game adds this card's
    // own +1000 to it right after this call — so what it holds now is exactly
    // what the player had when the card resolved, which is what the engine
    // replays each ±1000 against.
    const scoreBeforeCard = Math.max(0, parseInt(scoreInputRef.current, 10) || 0);
    chainRef.current = {
      cards: source.cards.map((c, i) => (i === source.cards.length - 1 ? { ...c, completed: true } : c)),
      plusMinusScores: isPlusMinus ? [...source.plusMinusScores, scoreBeforeCard] : source.plusMinusScores,
    };
    setAwaitingChoice(true);
    writeCache(currentTurnKey, true);
  }, [chainOrCurrentCard, currentTurnKey, writeCache]);

  // Continuing means the current card's goal was reached; the drawn card
  // joins the chain unresolved. Stamped with the POST-draw key — the store
  // already holds the new card, this render's prop just hasn't caught up.
  const recordDraw = useCallback((drawn: CardType) => {
    const source = chainOrCurrentCard();
    chainRef.current = {
      cards: [...source.cards.map((c, i) => (i === source.cards.length - 1 ? { ...c, completed: true } : c)), { card: drawn, completed: false }],
      plusMinusScores: source.plusMinusScores,
    };
    setAwaitingChoice(false);
    writeCache(buildTurnKey(roomId, round, currentPlayerIndex, drawn, ruleset), false);
  }, [chainOrCurrentCard, roomId, round, currentPlayerIndex, ruleset, writeCache]);

  // Whether any chain action happened this turn — read fresh at call time, so
  // commit callbacks (e.g. the Stop auto-continue) never see a stale value.
  const hasChain = useCallback(() => chainRef.current !== null, []);

  // Whether the chain may take one more card. Checked by Game BEFORE
  // drawCardMidTurn mutates the deck: every validator that carries a chain
  // (this hook's cache, the pushed snapshot, the turn summary) refuses
  // anything past MAX_CHAIN_CARDS wholesale — a draw beyond it would either
  // desync chain and deck (if recordDraw refused after the deck moved) or
  // get the whole turn thrown away on the next restore.
  const canDrawAnotherCard = useCallback((): boolean =>
    chainOrCurrentCard().cards.length < MAX_CHAIN_CARDS, [chainOrCurrentCard]);

  // What this classic physical turn did, card by card — the digital
  // counterpart is built inside DiceGame. With real dice the tutto count is
  // unknowable; completed cards are its floor (each continuation implies one,
  // a completed Kleeblatt implies two, a completed Feuerwerk implies none —
  // see TUTTOS_PER_COMPLETION). Digital counts the tuttos it actually saw, so
  // this is a floor under that number and never above it.
  const buildSummary = useCallback((ended: TurnEnd, lastCompleted: boolean, forfeitedScore = 0): TurnSummary => {
    const source = chainOrCurrentCard();
    const cards = source.cards.map((c, i) =>
      i === source.cards.length - 1 ? { ...c, completed: lastCompleted } : { ...c });
    return {
      cards,
      tuttoCount: cards.reduce((n, c) => n + (c.completed ? (TUTTOS_PER_COMPLETION[c.card] ?? DEFAULT_TUTTOS_PER_COMPLETION) : 0), 0),
      plusMinusScores: [...source.plusMinusScores],
      ended,
      ...(ended !== 'banked' && forfeitedScore > 0 ? { forfeitedScore } : {}),
    };
  }, [chainOrCurrentCard]);

  // The turn committed (banked, forfeited, or Stop-resolved) — nothing about
  // it may survive into the next one.
  const clearChain = useCallback(() => {
    chainRef.current = null;
    setAwaitingChoice(false);
    localStore.remove(PHYSICAL_TURN_STATE_KEY);
  }, []);

  return useMemo(() => ({
    awaitingChoice, hasChain, canDrawAnotherCard, completeCurrentCard, recordDraw, buildSummary, clearChain,
  }), [awaitingChoice, hasChain, canDrawAnotherCard, completeCurrentCard, recordDraw, buildSummary, clearChain]);
};
