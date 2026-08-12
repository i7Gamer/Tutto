import { localStore } from '../utils/storage';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Hand, Layers, RotateCw } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { playBuzzer, playSuccess, playTone, vibrateBust, vibrateSuccess } from '../utils/soundEffects';
import confetti from 'canvas-confetti';
import { rollDie, isBust, checkValidityAndScore, applyTuttoBonus, getMaxValidSelection } from '../utils/diceLogic';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../utils/coreGameEngine';
import { DEFAULT_RULESET } from '../utils/configValidation';
import { parseSavedDiceState, buildDiceSnapshot, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import { deriveTurnControls, sortKeptDiceForDisplay } from '../utils/diceTurnControls';
import { useAutoContinueCountdown } from '../hooks/useAutoContinueCountdown';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import {
  DIE_TUMBLE_MS, DIE_STAGGER_MS, DIE_FACE_SHUFFLE_MS, ROLL_SETTLE_BUFFER_MS,
  BUST_SUMMARY_DELAY_MS, LIVE_SNAPSHOT_DEBOUNCE_MS,
} from '../utils/uiTimings';
import { isTestEnv } from '../utils/env';
import { motion, AnimatePresence } from 'framer-motion';
import Die, { DiePips } from './game/Die';
import DiceSummary from './game/DiceSummary';
import DrawnCardReveal from './game/DrawnCardReveal';
import { MAX_CHAIN_CARDS } from '../types';
import type { CardType, Die as DieType, DiceSnapshot, Ruleset, TurnSummary, TurnCardPlayed, TurnEnd } from '../types';

interface DiceGameProps {
  currentCard: CardType | null;
  // Identifies the turn this instance was opened for (see buildTurnKey in
  // diceTurnState.ts). Left undefined, restoration is unconditional — matches
  // every test in this file that doesn't pass it and predates this prop.
  turnKey?: string;
  onComplete: (score: number, isSuccess: boolean, turnSummary?: TurnSummary) => void;
  onStateChange?: (snapshot: DiceSnapshot | null) => void;
  // Signals that the panel's own entrance animation has finished, so the dice
  // can start rolling automatically without visually overlapping it. Defaults
  // to true for callers (e.g. tests) that render this panel without an
  // entrance animation of their own.
  panelReady?: boolean;
  // Which rule set governs this turn. Classic turns can chain cards and
  // always hand a TurnSummary to onComplete.
  ruleset?: Ruleset;
  // Classic only: reveals the next card mid-turn (store drawCardMidTurn).
  // The chain choice is offered only when this is provided.
  onDrawCard?: () => CardType | null;
}

interface SummaryData {
  won: boolean;
  score: number;
  isTutto?: boolean;
  // The chain was ended by a drawn Stop card (classic) — everything is lost.
  stoppedByCard?: boolean;
}

const CARD_NAME_MAP: Partial<Record<CardType, string>> = {
  'Plus_Minus': 'Plus/Minus',
  '200': '200 Bonus',
  '300': '300 Bonus',
  '400': '400 Bonus',
  '500': '500 Bonus',
  '600': '600 Bonus',
};

const getDisplayCardName = (cardName: CardType | null): string => {
  if (!cardName) return '';
  return CARD_NAME_MAP[cardName] ?? cardName;
};

/**
 * The cards worth a fixed award for being completed rather than the dice they
 * were rolled with — Plus/Minus discards its dice outright, and a straight
 * scores none (checkValidityAndScore returns 0 for it).
 *
 * The running total counts this in the moment the selection completes the card,
 * so the panel names what the card will actually pay. It used to show the raw
 * dice instead: nothing at all for a straight or a classic Plus/Minus, and — in
 * modernized Plus/Minus — a dice total climbing toward a number the engine was
 * always going to replace with 1000.
 */
const FIXED_CARD_AWARD: Partial<Record<CardType, number>> = {
  Plus_Minus: PLUS_MINUS_SCORE,
  Kniffel: KNIFFEL_SCORE,
};

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
const readRestorableTurn = (turnKey: string | undefined) => {
  const restored = parseSavedDiceState(localStore.read(DICE_TURN_STATE_KEY));
  if (!restored) return null;
  if (turnKey !== undefined && restored.turnKey !== turnKey) {
    localStore.remove(DICE_TURN_STATE_KEY);
    return null;
  }
  return restored;
};

export default function DiceGame({ currentCard, turnKey, onComplete, onStateChange, panelReady = true, ruleset = DEFAULT_RULESET, onDrawCard }: DiceGameProps) {
  const { t } = useTranslation();
  const isClassic = ruleset === 'classic';

  // Read once, during the first render. This used to be an effect that called
  // eight setters, which meant mounting an empty dice table, painting it, and
  // only then correcting it into the turn the player was actually in the middle
  // of — a visible flash of a game they had not been playing.
  const [restored] = useState(() => readRestorableTurn(turnKey));
  // A bust is restored straight into its summary: the turn is already over and
  // what is left to show is its outcome.
  const restoredBust = restored?.busted
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
  const restoredTutto = !restoredBust && isClassic && restored && restored.keptDice.length === 6
    ? { won: true, score: restored.turnScore, isTutto: true }
    : null;
  // A classic chain had just drawn a Stop card when the app reloaded (the
  // turn key carries the current card, so a matching restore under 'Stop'
  // can only be that forfeit summary) — restore into it, not into a rollable
  // dice table for a card that allows no rolling.
  const restoredStopped = !restoredBust && !restoredTutto && isClassic && restored && currentCard === 'Stop'
    ? { won: false, score: 0, isTutto: false, stoppedByCard: true }
    : null;
  // A banked decision (Stop & Score, or a modernized turn-ending tutto —
  // both commit with the stopped marker) — restore into its success summary,
  // never a dice table where the decision could be rolled back into Roll
  // Again. All six dice put aside is what a tutto IS, so the kept-dice count
  // recovers the "Tutto!" headline.
  const restoredBanked = !restoredBust && !restoredTutto && !restoredStopped && restored?.stopped
    ? { won: true, score: restored.turnScore, isTutto: restored.keptDice.length === 6 }
    : null;
  // An empty table that is neither busted nor banked was snapshotted between
  // drawing a chain card and its first roll (the reveal panel below holds that
  // window open for as long as the player takes to dismiss it). Resuming it
  // has to roll: restoring as-is hands back a table with no dice on it and no
  // button that would put any there.
  const restoredMidDraw = !!restored && !restoredBust && !restoredTutto && !restoredStopped && !restoredBanked
    && restored.keptDice.length === 0 && restored.currentRoll.length === 0;

  const [keptDice, setKeptDice] = useState<DieType[]>(restored?.keptDice ?? []);
  const [currentRoll, setCurrentRoll] = useState<DieType[]>(restored?.currentRoll ?? []);
  const [displayRoll, setDisplayRoll] = useState<DieType[]>(restored?.currentRoll ?? []);
  const [rollingDiceIndices, setRollingDiceIndices] = useState<Set<string>>(new Set());
  const [turnScore, setTurnScore] = useState(restored?.turnScore ?? 0);
  const [kniffelProgress, setKniffelProgress] = useState<number[]>(restored?.kniffelProgress ?? []);
  const [isRolling, setIsRolling] = useState(false);
  const [hasRolled, setHasRolled] = useState(!!restored && !restoredMidDraw);
  const [bustState, setBustState] = useState(!!restoredBust);
  const [showSummary, setShowSummary] = useState(!!restoredBust || !!restoredTutto || !!restoredStopped || !!restoredBanked);
  const [summaryData, setSummaryData] = useState<SummaryData>(
    restoredBust ?? restoredTutto ?? restoredStopped ?? restoredBanked ?? { won: false, score: 0, isTutto: false },
  );
  // Whether the turn is decided and banked (Stop & Score, a modernized
  // turn-ending tutto, a completed Kleeblatt) — rides the snapshot so a
  // reload restores into the banked summary above.
  const [stopped, setStopped] = useState(!!restoredBanked);
  const [tuttosThisTurn, setTuttosThisTurn] = useState(restored?.tuttosThisTurn ?? 0);

  // The classic chain, held in a ref so summary/bust callbacks always read the
  // current value; chainVersion ticks whenever it changes so the snapshot
  // effect below re-sends. Cards before the last are completed by definition.
  const [initialChain] = useState<{ cards: TurnCardPlayed[]; tuttoCount: number; plusMinusScores: number[]; ended: TurnEnd; forfeitedScore?: number }>(() => {
    const cardList = restored?.cardsThisTurn ?? (currentCard ? [currentCard] : []);
    return {
      cards: cardList.map((card, i) => ({ card, completed: i < cardList.length - 1 || (i === cardList.length - 1 && !!restoredTutto) })),
      tuttoCount: restored?.chainTuttoCount ?? 0,
      plusMinusScores: restored?.plusMinusScores ?? [],
      ended: restoredStopped ? 'stopCard' : restoredBust ? (restoredBust.won ? 'banked' : 'null') : 'banked',
      forfeitedScore: (restoredBust && !restoredBust.won) || restoredStopped ? restored?.turnScore : undefined,
    };
  });
  const chainRef = useRef(initialChain);
  // Render-safe mirror of chainRef.current.cards.length (refs must not be
  // read during render); only a draw ever changes it.
  const [chainCardCount, setChainCardCount] = useState(initialChain.cards.length);
  // A draw was requested but the new card hasn't arrived through the
  // currentCard prop yet — roll() must not fire until it has, or its closure
  // would judge the fresh roll against the previous card's rules.
  const pendingChainRollRef = useRef<{ card: CardType; base: number } | null>(null);
  // The card just drawn, held on screen until the player dismisses it. It is
  // the only place they see it: this modal covers the board, and the very next
  // thing to happen is a roll judged by the new card's rules.
  const [revealedCard, setRevealedCard] = useState<CardType | null>(null);

  const selectedRolls = currentRoll.filter(d => d.selected);

  // Plus/Minus is worth exactly +1000 for completing it and nothing otherwise,
  // under EITHER rule set — the dice rolled toward it never count. Classic adds
  // that 1000 to the chain total here; modernized lets the engine set the whole
  // turn to it (calculateNextTurn). Counting the dice was harmless arithmetic
  // in modernized — the engine overwrote the total either way — but it put a
  // number on screen that nobody was ever awarded.
  const countsDicePoints = currentCard !== 'Plus_Minus';

  // The selected values are picked out inside the memo rather than passed in.
  // Built with .filter/.map they are a brand-new array on every render, so a
  // dependency on them would invalidate this every render whether or not the
  // selection actually changed — which is the whole thing the memo is for.
  const validation = useMemo(
    () => checkValidityAndScore(currentRoll.filter(d => d.selected).map(d => d.val), currentCard, kniffelProgress, ruleset),
    [currentRoll, currentCard, kniffelProgress, ruleset],
  );

  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => pendingTimers.current.forEach(clearTimeout), []);

  const roll = useCallback((numDice: number, kniffelArray: number[] | null = null, scoreSoFar = 0) => {
    pendingTimers.current.forEach(clearTimeout);
    pendingTimers.current = [];
    setIsRolling(true);
    setBustState(false);

    playTone(600, 'sine', 0.1);

    const newRollVals = Array.from({ length: numDice }, () => rollDie());
    // crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) —
    // this would throw on every roll when playing over plain http:// on a LAN.
    const finalRolls: DieType[] = newRollVals.map((val) => ({ id: uuidv4(), val, selected: false }));

    setCurrentRoll(finalRolls);
    setDisplayRoll(finalRolls.map(r => ({ ...r, val: rollDie() })));
    setHasRolled(true);

    const initialRolling = new Set(finalRolls.map(r => r.id));
    setRollingDiceIndices(initialRolling);

    const isTest = isTestEnv();
    const baseTumbleTime = isTest ? 0 : DIE_TUMBLE_MS;
    const staggerDelay = isTest ? 0 : DIE_STAGGER_MS;

    finalRolls.forEach((r, idx) => {
      if (isTest) {
        setRollingDiceIndices(prev => {
          const next = new Set(prev);
          next.delete(r.id);
          return next;
        });
        setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
      } else {
        pendingTimers.current.push(setTimeout(() => {
          setRollingDiceIndices(prev => {
            const next = new Set(prev);
            next.delete(r.id);
            return next;
          });
          setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
          playTone(400 + (idx * 50), 'sine', 0.05);
        }, baseTumbleTime + (idx * staggerDelay)));
      }
    });

    const totalAnimationTime = baseTumbleTime + ((finalRolls.length - 1) * staggerDelay);

    const finalizeRoll = () => {
      setIsRolling(false);
      if (isBust(newRollVals, currentCard, kniffelArray || kniffelProgress, ruleset)) {
        setBustState(true);
        playBuzzer();
        vibrateBust();
        if (isClassic) {
          // A Feuerwerk null BANKS the whole accumulated turn (official
          // rule); every other null forfeits the entire chain.
          if (currentCard === 'Feuerwerk' && scoreSoFar > 0) {
            chainRef.current.ended = 'banked';
            const chain = chainRef.current.cards;
            if (chain.length > 0) chain[chain.length - 1].completed = true;
          } else {
            chainRef.current.ended = 'null';
            chainRef.current.forfeitedScore = scoreSoFar;
          }
        }
        const getSummary = () => {
          if (currentCard === 'Kleeblatt') {
            return { won: false, score: 0 };
          } else if (currentCard === 'Feuerwerk') {
            return { won: scoreSoFar > 0, score: scoreSoFar, isTutto: false };
          } else {
            return { won: false, score: 0, isTutto: false };
          }
        };

        if (isTest) {
          setSummaryData(getSummary());
          setShowSummary(true);
        } else {
          pendingTimers.current.push(setTimeout(() => {
            setSummaryData(getSummary());
            setShowSummary(true);
          }, BUST_SUMMARY_DELAY_MS));
        }
      } else if (isClassic && currentCard === 'Feuerwerk') {
        // Official Feuerwerk keeps EVERY scoring die — the selection is
        // forced (toggleDie is a no-op for this card under classic).
        const forced = new Set(getMaxValidSelection(newRollVals, 'Feuerwerk', [], ruleset));
        setCurrentRoll(prev => prev.map((d, i) => ({ ...d, selected: forced.has(i) })));
      }
    };

    if (isTest) {
      finalizeRoll();
    } else {
      pendingTimers.current.push(setTimeout(finalizeRoll, totalAnimationTime + ROLL_SETTLE_BUFFER_MS));
    }
  }, [currentCard, kniffelProgress, ruleset, isClassic]);

  // roll is rebuilt whenever kniffelProgress changes, which happens on every
  // kept die. Reached through a ref so the effect below can depend on the
  // panel appearing and nothing else — depending on roll itself would restart
  // the turn's opening roll in the middle of that turn.
  const rollRef = useRef(roll);
  useEffect(() => { rollRef.current = roll; });

  // Auto-starts the first roll once the panel has finished appearing — there's
  // no manual "Roll" button anymore. Skipped for a resumed turn, which already
  // has dice on the table; a mid-draw resume has none, and rolls carrying the
  // chain total it must bank on a Feuerwerk null.
  useEffect(() => {
    if (!panelReady || (restored && !restoredMidDraw)) return;
    rollRef.current(6, null, restored?.turnScore ?? 0);
  }, [panelReady, restored, restoredMidDraw]);

  useEffect(() => {
    if (rollingDiceIndices.size === 0) return;
    if (isTestEnv()) return;
    const interval = setInterval(() => {
      setDisplayRoll(prev => prev.map(d => {
        const isDieRolling = rollingDiceIndices.has(d.id);
        const correctVal = currentRoll.find(cr => cr.id === d.id)?.val;
        const isSettled = correctVal !== undefined && d.val === correctVal;
        return isDieRolling && !isSettled ? { ...d, val: Math.floor(Math.random() * 6) + 1 } : d;
      }));
    }, DIE_FACE_SHUFFLE_MS);
    return () => clearInterval(interval);
  }, [rollingDiceIndices, currentRoll]);

  const handleAction = (action: 'roll' | 'stop' | 'draw') => {
    if (!validation.valid && action !== 'stop') return;

    let newTurnScore = turnScore + (countsDicePoints ? validation.score : 0);
    const newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];

    const isTutto = newKeptDice.length === 6;

    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore, currentCard);
      if (isClassic) chainRef.current.tuttoCount += 1;
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();
      vibrateSuccess();

      if (currentCard === 'Kleeblatt') {
        if (tuttosThisTurn === 0) {
          setTuttosThisTurn(1);
          setKeptDice([]);
          setTurnScore(newTurnScore);
          setKniffelProgress(newKniffelProgress);
          roll(6, newKniffelProgress, newTurnScore);
          return;
        } else {
          if (isClassic) {
            const chain = chainRef.current.cards;
            if (chain.length > 0) chain[chain.length - 1].completed = true;
            chainRef.current.ended = 'banked';
          }
          // Committed + marked stopped (like Stop & Score below) so the won
          // game survives a reload: the snapshot otherwise still held the
          // pre-win table, and restoring handed back dice that could reroll
          // — and bust away — a game already won.
          setTurnScore(newTurnScore);
          setKeptDice(newKeptDice);
          setCurrentRoll([]);
          setDisplayRoll([]);
          setKniffelProgress(newKniffelProgress);
          setStopped(true);
          setSummaryData({ won: true, score: newTurnScore, isTutto: true });
          setShowSummary(true);
          return;
        }
      } else if (isClassic && currentCard !== 'Feuerwerk') {
        // Classic: the fixed card scores are added here, client-side — the
        // engine's summary path deliberately takes the total as-is.
        if (currentCard === 'Kniffel') {
          newTurnScore += KNIFFEL_SCORE;
        } else if (currentCard === 'Plus_Minus') {
          // Recorded BEFORE the award: the engine replays each ±1000 against
          // what the player held when the card resolved, and you are not yet
          // holding the 1000 the card is about to pay you.
          chainRef.current.plusMinusScores.push(newTurnScore);
          newTurnScore += PLUS_MINUS_SCORE;
        }
        const chain = chainRef.current.cards;
        if (chain.length > 0) chain[chain.length - 1].completed = true;
        chainRef.current.ended = 'banked';
        // Committed (not just carried in the summary data) so a reload
        // restores the decision, not the pre-tutto table it could be rolled
        // back into.
        setTurnScore(newTurnScore);
        setKeptDice(newKeptDice);
        setCurrentRoll([]);
        setDisplayRoll([]);
        setKniffelProgress(newKniffelProgress);
        // Bank or draw was decided by which button was pressed — the summary
        // no longer asks a second time (it used to, under a heading that said
        // the turn had stopped). A draw the store refuses banks instead.
        if (action === 'draw' && drawNextCard(newTurnScore)) return;
        setStopped(true);
        setSummaryData({ won: true, score: newTurnScore, isTutto: true });
        setShowSummary(true);
        return;
      } else if (currentCard !== 'Feuerwerk') {
        // Modernized turn-ending tutto: committed + marked stopped (like the
        // classic branch above and Stop & Score below) so a reload restores
        // into this decided summary — not the pre-tutto table, where the
        // tutto could be rolled back and played on past the turn's end.
        // Spectators likewise see the banked total, not the stale board.
        setTurnScore(newTurnScore);
        setKeptDice(newKeptDice);
        setCurrentRoll([]);
        setDisplayRoll([]);
        setKniffelProgress(newKniffelProgress);
        setStopped(true);
        setSummaryData({ won: true, score: newTurnScore, isTutto: true });
        setShowSummary(true);
        return;
      }
    }

    if (action === 'stop') {
      if (isClassic) chainRef.current.ended = 'banked';
      // Committed (like the classic tutto choice above) so the decision
      // survives a reload: the snapshot otherwise still held the pre-stop
      // table, and restoring handed the banked decision back — free to Roll
      // Again instead. Spectators also kept watching the pre-stop board
      // through the whole countdown.
      setTurnScore(newTurnScore);
      setKeptDice(newKeptDice);
      setCurrentRoll([]);
      setDisplayRoll([]);
      setKniffelProgress(newKniffelProgress);
      setStopped(true);
      setSummaryData({ won: true, score: newTurnScore, isTutto });
      setShowSummary(true);
      return;
    }

    if (action === 'roll') {
      setTurnScore(newTurnScore);
      setKniffelProgress(newKniffelProgress);
      if (isTutto) {
        setKeptDice([]);
        roll(6, newKniffelProgress, newTurnScore);
      } else {
        setKeptDice(newKeptDice);
        roll(6 - newKeptDice.length, newKniffelProgress, newTurnScore);
      }
    }
  };

  const toggleDie = (id: string) => {
    if (bustState || showSummary || isRolling) return;
    // Official Feuerwerk keeps every scoring die — the forced selection made
    // in finalizeRoll must not be editable.
    if (isClassic && currentCard === 'Feuerwerk') return;
    setCurrentRoll(prev => prev.map(d => d.id === id ? { ...d, selected: !d.selected } : d));
  };

  const selectAllValid = () => {
    if (bustState || showSummary || isRolling || !hasRolled) return;
    const validIndices = new Set(getMaxValidSelection(currentRoll.map(d => d.val), currentCard, kniffelProgress, ruleset));
    setCurrentRoll(prev => prev.map((d, i) => ({ ...d, selected: validIndices.has(i) })));
  };

  // Classic: reveal the next card after a tutto and keep the accumulated total
  // at risk. `base` is the chain total the new card is played on — passed in
  // rather than read from turnScore, because the caller commits the tutto that
  // produced it in the same batch, where this closure would still see the
  // pre-tutto value.
  // Returns whether a card actually came out: the store refuses to draw for a
  // finished game or an empty deck, and the caller has already committed the
  // tutto by then — so a refusal has to fall back to banking it rather than
  // leave the panel on a decided turn with nothing left to press.
  const drawNextCard = useCallback((base: number): boolean => {
    if (!onDrawCard) return false;
    const newCard = onDrawCard();
    if (!newCard) return false;
    chainRef.current.cards.push({ card: newCard, completed: false });
    setChainCardCount(c => c + 1);
    setShowSummary(false);
    setTurnScore(base);
    setKeptDice([]);
    setCurrentRoll([]);
    setDisplayRoll([]);
    setKniffelProgress([]);
    setBustState(false);
    if (newCard === 'Kleeblatt') setTuttosThisTurn(0);
    if (newCard === 'Stop') {
      chainRef.current.ended = 'stopCard';
      chainRef.current.forfeitedScore = base;
      playBuzzer();
      vibrateBust();
    } else {
      setSummaryData({ won: false, score: 0, isTutto: false });
      // The fresh roll waits for BOTH the reveal to be dismissed and the new
      // card to arrive through the currentCard prop (see pendingChainRollRef
      // above and the effect below).
      pendingChainRollRef.current = { card: newCard, base };
    }
    setRevealedCard(newCard);
    return true;
  }, [onDrawCard]);

  // Dismissing the reveal resumes the turn: for every card that can be played
  // on, by releasing the deferred roll below; for a drawn Stop, by showing the
  // forfeit the draw already committed to the chain.
  const acknowledgeDrawnCard = useCallback(() => {
    const drawn = revealedCard;
    setRevealedCard(null);
    if (drawn === 'Stop') {
      setSummaryData({ won: false, score: 0, isTutto: false, stoppedByCard: true });
      setShowSummary(true);
    }
  }, [revealedCard]);

  useEffect(() => {
    const pending = pendingChainRollRef.current;
    if (!pending || revealedCard || currentCard !== pending.card) return;
    pendingChainRollRef.current = null;
    rollRef.current(6, [], pending.base);
  }, [currentCard, revealedCard]);

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);

  // The chain fields ride every snapshot in classic so a reconnect resumes
  // the whole chain, not just the current card's dice. chainRef is read at
  // send time (always current); the state deps above it re-fire the effect.
  const chainSnapshotFields = () => (isClassic ? {
    cardsThisTurn: chainRef.current.cards.map(c => c.card),
    plusMinusScores: [...chainRef.current.plusMinusScores],
    chainTuttoCount: chainRef.current.tuttoCount,
  } : {});

  useEffect(() => {
    if (!onStateChangeRef.current || !hasRolled || bustState) return;
    // A send DURING the roll is allowed exactly while dice are still
    // tumbling — it is what carries rollingDiceIds to spectators, whose
    // tumble rendering (GameControls) was unreachable when every snapshot
    // waited for isRolling to clear: by finalizeRoll, the per-die settle
    // timers have already emptied the set, so live data never held a single
    // rolling id. The settle gap (still isRolling, nothing left tumbling)
    // stays skipped; finalize's own state change sends the settled snapshot.
    if (isRolling && rollingDiceIndices.size === 0) return;
    const timer = setTimeout(() => {
      onStateChangeRef.current?.(buildDiceSnapshot({
        turnScore, keptDice, currentRoll, kniffelProgress, tuttosThisTurn, rollingDiceIndices, stopped,
        ...chainSnapshotFields(),
      }));
    }, LIVE_SNAPSHOT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptDice, currentRoll, turnScore, hasRolled, rollingDiceIndices, isRolling, bustState, kniffelProgress, tuttosThisTurn, stopped]);

  // What a bust snapshot is made of, as of the most recent commit. Held in a
  // ref, and updated by an effect declared ahead of the one that reads it so
  // it is already current when that runs: the send below has to happen on the
  // bust edge and nowhere else, and depending on these values directly would
  // re-send the same final snapshot every time one of them settled afterwards.
  const bustSnapshotRef = useRef({ turnScore, keptDice, currentRoll, kniffelProgress, tuttosThisTurn });
  useEffect(() => {
    bustSnapshotRef.current = { turnScore, keptDice, currentRoll, kniffelProgress, tuttosThisTurn };
  });

  useEffect(() => {
    if (!bustState || !onStateChangeRef.current || !hasRolled) return;
    onStateChangeRef.current(buildDiceSnapshot({ ...bustSnapshotRef.current, busted: true, ...chainSnapshotFields() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bustState, hasRolled]);

  const summaryDataRef = useRef(summaryData);
  useEffect(() => { summaryDataRef.current = summaryData; }, [summaryData]);

  const finishGame = useCallback(() => {
    const data = summaryDataRef.current;
    if (isClassic) {
      const chain = chainRef.current;
      onComplete(data.score || 0, data.won || false, {
        cards: chain.cards.map(c => ({ ...c })),
        tuttoCount: chain.tuttoCount,
        plusMinusScores: [...chain.plusMinusScores],
        ended: chain.ended,
        ...(chain.ended !== 'banked' && chain.forfeitedScore ? { forfeitedScore: chain.forfeitedScore } : {}),
      });
    } else {
      onComplete(data.score || 0, data.won || false);
    }
  }, [onComplete, isClassic]);

  // Whether this summary's score is a classic chain total the player is
  // banking — true for a tutto on every card except Feuerwerk (its null
  // already banks and ends the turn) and Kleeblatt (a completed one has
  // already won the game). What the summary calls the score and its button.
  const banksChainTotal = isClassic && showSummary && summaryData.won && !!summaryData.isTutto
    && currentCard !== 'Kleeblatt' && currentCard !== 'Feuerwerk' && !!onDrawCard;

  // Auto-continue to the next player once the turn resolves — for a success the
  // same way as for a bust (the spectator view relies on this turn ending on its
  // own; only the active player can advance the shared game state). Every
  // summary reached here is a decided turn: the classic bank-or-draw choice is
  // made in the button row below, before any summary is shown.
  const continueCountdown = useAutoContinueCountdown({
    shouldStart: showSummary,
    onElapsed: finishGame,
  });

  const isMakingTutto = keptDice.length + selectedRolls.length === 6;

  // What the selection on the table would add to the running total: its dice,
  // or — for a card whose value is a fixed award — that award, once the
  // selection actually completes the card.
  const fixedCardAward = (currentCard ? FIXED_CARD_AWARD[currentCard] : 0) ?? 0;
  const pendingSelectionScore = !validation.valid ? 0
    : fixedCardAward > 0 ? (isMakingTutto ? fixedCardAward : 0)
      : countsDicePoints ? validation.score : 0;

  const { canStop, isRollAgainApplicable, stopButtonText: stopButtonTextKey } = deriveTurnControls({
    currentCard,
    hasRolled,
    bustState,
    isMakingTutto,
    tuttosThisTurn,
  });
  const stopButtonText = t(stopButtonTextKey.key, stopButtonTextKey.fallback);

  // Drawing on is offered next to Stop & Score, on the very selection that
  // completes the tutto — one choice, in the panel that asked it, instead of a
  // second panel offering to carry on under a heading that said the turn had
  // stopped. Feuerwerk never gets here (its null banks and ends the turn) and
  // a completed Kleeblatt has already won the game. Past MAX_CHAIN_CARDS the
  // chain can only bank: every validator that carries one (resume cache,
  // pushed snapshot, turn summary) refuses anything longer wholesale.
  const canDrawAfterTutto = isClassic && !!onDrawCard && isMakingTutto && canStop
    && currentCard !== 'Feuerwerk' && currentCard !== 'Kleeblatt'
    && chainCardCount < MAX_CHAIN_CARDS;

  const displayKeptDice = sortKeptDiceForDisplay(keptDice, currentCard, kniffelProgress, ruleset);

  // A turn is select → roll or stop, repeated. Each shortcut is bound only when
  // its button is enabled, so a key can never do something a click could not —
  // an unavailable action passes `undefined` and the key falls through to the
  // page. Listed for players in HelpPopup's shortcuts section.
  const canAct = hasRolled && !bustState && !isRolling && !showSummary && !revealedCard;
  const canSubmitSelection = canAct && validation.valid;

  // Game renders this panel inside a modal, so an aria-modal element is always
  // present around it — passed to the hook so the panel's own keys are not
  // silenced by the very dialog they belong to (a confirm dialog stacked on
  // top still silences them).
  const panelRef = useRef<HTMLDivElement>(null);
  useKeyboardShortcuts({
    r: canSubmitSelection && isRollAgainApplicable ? () => handleAction('roll') : undefined,
    s: canSubmitSelection && canStop ? () => handleAction('stop') : undefined,
    a: canAct ? selectAllValid : undefined,
    d: canSubmitSelection && canDrawAfterTutto ? () => handleAction('draw') : undefined,
  }, { ownerRef: panelRef });

  return (
    <div ref={panelRef} className={`bg-white dark:bg-slate-800/95 backdrop-blur-xl border border-white/40 shadow-2xl overflow-hidden rounded-3xl flex flex-col items-center w-full ${showSummary || revealedCard ? 'max-h-[90vh]' : 'h-[calc(100dvh-2rem)] sm:h-auto sm:max-h-[90vh]'}`}>
      {!showSummary && !revealedCard && (
        <div className="w-full shrink-0 bg-black/5 dark:bg-white/5 border-b border-gray-200 dark:border-slate-600 p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 m-0">{t('dice.title', 'Dice Game')} - {getDisplayCardName(currentCard)}</h2>
        </div>
      )}

      <div className="px-8 pt-6 pb-8 sm:p-8 w-full flex-1 overflow-y-auto">
        {revealedCard ? (
          <DrawnCardReveal
            card={revealedCard}
            chainCardCount={chainCardCount}
            turnScore={turnScore}
            onContinue={acknowledgeDrawnCard}
          />
        ) : showSummary ? (
          <DiceSummary
            summaryData={summaryData}
            continueCountdown={continueCountdown}
            finishGame={finishGame}
            currentCard={currentCard}
            banksChainTotal={banksChainTotal}
          />
        ) : (
          <>
            <div className="text-center mb-6 sm:mb-8">
              <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">{t('dice.current_score', 'Current Score')}</div>
              {/* Keyed by turnScore alone (not the live selection) so the pop
                  animation plays when a roll is banked, not on every die
                  click that flips the selection valid/invalid. */}
              <motion.div key={turnScore} data-testid="dice-current-score" initial={{ scale: 1.2 }} animate={{ scale: 1 }} className="text-5xl font-black text-indigo-600 dark:text-indigo-400">
                {turnScore + pendingSelectionScore}
              </motion.div>
              {isClassic && chainCardCount > 1 && (
                <div className="text-indigo-500 mt-2 font-bold text-sm bg-indigo-50 dark:bg-indigo-900/30 inline-block px-4 py-1 rounded-full border border-indigo-200 dark:border-indigo-800">
                  {t('dice.chain_card_count', 'Card {{count}} of this turn', { count: chainCardCount })}
                </div>
              )}
              {currentCard === 'Kleeblatt' && (
                <div className="text-emerald-500 mt-2 font-bold text-lg bg-emerald-50 inline-block px-4 py-1 rounded-full border border-emerald-200">
                  {t('dice.tuttos_count', 'Tuttos: {{count}} / 2', { count: tuttosThisTurn })}
                </div>
              )}
            </div>

            <div className="mb-6">
              <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t('dice.kept_dice', 'Kept Dice')}</h4>
              <div className="min-h-[80px] p-4 bg-black/5 dark:bg-white/5 rounded-2xl flex gap-3 flex-wrap items-center border border-gray-200 dark:border-slate-600/50 shadow-inner">
                <AnimatePresence>
                  {/* Keyed by die id, not index: Kniffel re-sorts kept dice for
                      display, and index keys would pin AnimatePresence's enter/
                      exit animations to the wrong die after a reorder. */}
                  {displayKeptDice.map(d => (
                    <motion.div key={d.id} data-testid="die" initial={{ scale: 0, rotate: -180 }} animate={{ scale: 1, rotate: 0 }} className="relative w-14 h-14 bg-indigo-600 text-white rounded-xl shadow-md flex items-center justify-center border-2 border-indigo-400">
                      <DiePips val={d.val} isSelected={false} bustState={false} size="large" isIndigo />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {displayKeptDice.length === 0 && <span className="text-gray-400 font-medium italic mx-auto">{t('dice.none', 'None')}</span>}
              </div>
            </div>

            <div className="mb-8">
              <div className="flex items-center justify-between mb-2 sm:mb-3">
                <h4 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('dice.current_roll', 'Current Roll')}</h4>
                {hasRolled && !isRolling && !bustState && (
                  <button className="text-xs font-bold px-2.5 py-1 rounded-md border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors" onClick={selectAllValid}>
                    {t('dice.select_all_valid', 'Select all')}
                  </button>
                )}
              </div>
              <div className="min-h-[80px] p-4 bg-white dark:bg-slate-800 rounded-2xl flex gap-3 flex-wrap justify-center border border-gray-200 dark:border-slate-600 shadow-xs">
                {displayRoll.map(d => {
                  const isDieTumbling = rollingDiceIndices.has(d.id);
                  const isSelected = currentRoll.find(cr => cr.id === d.id)?.selected ?? false;
                  return (
                    <Die key={d.id} die={d} isSelected={isSelected} isDieTumbling={isDieTumbling} bustState={bustState} onToggle={toggleDie} />
                  );
                })}
              </div>
              {bustState && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center text-red-500 text-2xl font-black mt-6 bg-red-50 py-3 rounded-xl border border-red-100">
                  {t('dice.bust_description', 'Bust! (Volltreffer/Niete)')}
                </motion.div>
              )}
              {!bustState && (
                <div className="text-center mt-3 min-h-[24px]">
                  {/* Always mounted (visibility toggled, not presence) so
                      this line's reserved space never pops in/out as the
                      selection flips valid/invalid. */}
                  <span
                    className={`text-red-500 font-bold bg-red-50 px-3 py-1 rounded-full border border-red-100 ${
                      !validation.valid && selectedRolls.length > 0 ? '' : 'invisible'
                    }`}
                  >
                    {t('dice.invalid_selection', 'Invalid selection')}
                  </span>
                </div>
              )}
            </div>

            <AnimatePresence>
              {hasRolled && !bustState && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row gap-4 justify-center mt-8 pt-6 border-t border-gray-100 dark:border-slate-700">
                  {isRollAgainApplicable && (
                    <button
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid && !isRolling ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      disabled={!validation.valid || isRolling}
                      onClick={() => handleAction('roll')}
                    >
                      <RotateCw size={20} /> {t('dice.roll_again', 'Roll Again')}
                    </button>
                  )}
                  {canStop && (
                    <button
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid && !isRolling ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      disabled={!validation.valid || isRolling}
                      onClick={() => handleAction('stop')}
                    >
                      <Hand size={20} /> {stopButtonText}
                    </button>
                  )}
                  {canDrawAfterTutto && (
                    <button
                      data-testid="draw-next-card"
                      className={`flex-1 flex justify-center items-center gap-2 py-4 rounded-xl font-bold text-lg transition-all ${validation.valid && !isRolling ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/30' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                      disabled={!validation.valid || isRolling}
                      onClick={() => handleAction('draw')}
                    >
                      <Layers size={20} /> {t('dice.draw_next_card', 'Draw next card — risk everything!')}
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}
