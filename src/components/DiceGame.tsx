import { useState, useEffect, useMemo, useReducer, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { playBuzzer, playSuccess, playTone, vibrateBust, vibrateSuccess } from '../utils/soundEffects';
import confetti from 'canvas-confetti';
import { rollDie, isBust, checkValidityAndScore, applyTuttoBonus, getMaxValidSelection } from '../utils/diceLogic';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../utils/coreGameEngine';
import { DEFAULT_RULESET } from '../utils/configValidation';
import { buildDiceSnapshot } from '../utils/diceTurnState';
import { deriveTurnControls, sortKeptDiceForDisplay } from '../utils/diceTurnControls';
import { readRestorableTurn, deriveRestoredTurn, type RestoredChain } from '../utils/diceTurnRestore';
import { diceTurnReducer, initialDiceTurnState } from '../utils/diceTurnReducer';
import { getDisplayCardName } from '../utils/cardVisuals';
import { useAutoContinueCountdown } from '../hooks/useAutoContinueCountdown';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import {
  DIE_TUMBLE_MS, DIE_STAGGER_MS, DIE_FACE_SHUFFLE_MS, ROLL_SETTLE_BUFFER_MS,
  BUST_SUMMARY_DELAY_MS, LIVE_SNAPSHOT_DEBOUNCE_MS, DISCARDED_DRAW_RECOVERY_MS,
} from '../utils/uiTimings';
import DiceSummary from './game/DiceSummary';
import DrawnCardReveal from './game/DrawnCardReveal';
import TurnScoreHeader from './game/TurnScoreHeader';
import KeptDiceTray from './game/KeptDiceTray';
import CurrentRollBoard from './game/CurrentRollBoard';
import TurnActionBar from './game/TurnActionBar';
import { MAX_CHAIN_CARDS } from '../types';
import { DIE_FACES, TOTAL_DICE } from '../utils/turnShapes';
import type { CardType, Die as DieType, DiceSnapshot, Ruleset, TurnSummary } from '../types';

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

export default function DiceGame({ currentCard, turnKey, onComplete, onStateChange, panelReady = true, ruleset = DEFAULT_RULESET, onDrawCard }: DiceGameProps) {
  const { t } = useTranslation();
  const isClassic = ruleset === 'classic';

  // Read once, during the first render. This used to be an effect that called
  // eight setters, which meant mounting an empty dice table, painting it, and
  // only then correcting it into the turn the player was actually in the middle
  // of — a visible flash of a game they had not been playing.
  const [restored] = useState(() => readRestorableTurn(turnKey));
  // What to resume into. Every branch of that judgment — re-deriving a
  // mid-tumble bust, Feuerwerk's forced keep, banked decisions, the chain —
  // lives and is unit-tested in diceTurnRestore.ts.
  //
  // Frozen at mount, like `restored` above and `initialChain` below, because it
  // is a reading of THAT snapshot and nothing later can change what the
  // snapshot said. It used to be recomputed every render, which was not merely
  // a wasted object: the verdict is card-dependent through the stoppedByCard
  // branch, so `midDraw` was false while currentCard said 'Stop' and true the
  // moment the prop moved off it. midDraw is a dependency of the opening-roll
  // effect below, whose only brake for a restored turn is `!restore.midDraw` —
  // so a discarded Stop draw reverting the card flipped the dep and fired a
  // fresh six-dice roll underneath the summary the recovery had just opened,
  // costing the player the whole banked chain on a busting roll.
  const [restore] = useState(() => deriveRestoredTurn({ restored, currentCard, ruleset }));

  // The turn's semantic machine — every state a snapshot carries or a reload
  // restores, committed one action at a time (diceTurnReducer.ts) instead of
  // through blocks of five to eight setters that each had to remember every
  // field. What stays as useState below is presentation: the tumble
  // animation's display faces, settle set and in-flight flag, plus the
  // drawn-card reveal modal.
  const [machine, dispatch] = useReducer(diceTurnReducer, { restored, restore }, initialDiceTurnState);
  const {
    keptDice, currentRoll, turnScore, kniffelProgress, hasRolled, bustState,
    stopped, showSummary, summaryData, tuttosThisTurn, chainCardCount,
  } = machine;
  const [displayRoll, setDisplayRoll] = useState<DieType[]>(restored?.currentRoll ?? []);
  const [rollingDiceIndices, setRollingDiceIndices] = useState<Set<string>>(new Set());
  const [isRolling, setIsRolling] = useState(false);

  // The classic chain, held in a ref so summary/bust callbacks always read the
  // current value; the snapshot effect below re-reads it whenever one of its
  // state deps ticks.
  const [initialChain] = useState<RestoredChain>(() => restore.initialChain);
  const chainRef = useRef(initialChain);
  // Its render-safe length mirror is machine.chainCardCount (refs must not be
  // read during render); only CHAIN_DRAWN / DRAW_ABANDONED ever move it.
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

    playTone(600, 'sine', 0.1);

    const newRollVals = Array.from({ length: numDice }, () => rollDie());
    // crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) —
    // this would throw on every roll when playing over plain http:// on a LAN.
    const finalRolls: DieType[] = newRollVals.map((val) => ({ id: uuidv4(), val, selected: false }));

    dispatch({ type: 'ROLL_STARTED', rolls: finalRolls });
    setDisplayRoll(finalRolls.map(r => ({ ...r, val: rollDie() })));

    const initialRolling = new Set(finalRolls.map(r => r.id));
    setRollingDiceIndices(initialRolling);

    finalRolls.forEach((r, idx) => {
      pendingTimers.current.push(setTimeout(() => {
        setRollingDiceIndices(prev => {
          const next = new Set(prev);
          next.delete(r.id);
          return next;
        });
        setDisplayRoll(prev => prev.map(d => d.id === r.id ? { ...d, val: r.val } : d));
        playTone(400 + (idx * 50), 'sine', 0.05);
      }, DIE_TUMBLE_MS + (idx * DIE_STAGGER_MS)));
    });

    const totalAnimationTime = DIE_TUMBLE_MS + ((finalRolls.length - 1) * DIE_STAGGER_MS);

    const finalizeRoll = () => {
      setIsRolling(false);
      if (isBust(newRollVals, currentCard, kniffelArray || kniffelProgress, ruleset)) {
        dispatch({ type: 'ROLL_BUSTED' });
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

        pendingTimers.current.push(setTimeout(() => {
          dispatch({ type: 'SUMMARY_SHOWN', summary: getSummary() });
        }, BUST_SUMMARY_DELAY_MS));
      } else if (isClassic && currentCard === 'Feuerwerk') {
        dispatch({ type: 'FEUERWERK_SELECTION_FORCED', ruleset });
      }
    };

    pendingTimers.current.push(setTimeout(finalizeRoll, totalAnimationTime + ROLL_SETTLE_BUFFER_MS));
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
    if (!panelReady || (restored && !restore.midDraw)) return;
    rollRef.current(TOTAL_DICE, null, restored?.turnScore ?? 0);
  }, [panelReady, restored, restore.midDraw]);

  useEffect(() => {
    if (rollingDiceIndices.size === 0) return;
    const interval = setInterval(() => {
      setDisplayRoll(prev => prev.map(d => {
        const isDieRolling = rollingDiceIndices.has(d.id);
        const correctVal = currentRoll.find(cr => cr.id === d.id)?.val;
        const isSettled = correctVal !== undefined && d.val === correctVal;
        return isDieRolling && !isSettled ? { ...d, val: Math.floor(Math.random() * DIE_FACES) + 1 } : d;
      }));
    }, DIE_FACE_SHUFFLE_MS);
    return () => clearInterval(interval);
  }, [rollingDiceIndices, currentRoll]);

  const handleAction = (action: 'roll' | 'stop' | 'draw') => {
    if (!validation.valid && action !== 'stop') return;

    let newTurnScore = turnScore + (countsDicePoints ? validation.score : 0);
    const newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];

    const isTutto = newKeptDice.length === TOTAL_DICE;

    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore, currentCard);
      if (isClassic) chainRef.current.tuttoCount += 1;
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();
      vibrateSuccess();

      if (currentCard === 'Kleeblatt') {
        if (tuttosThisTurn === 0) {
          dispatch({ type: 'KLEEBLATT_FIRST_TUTTO', turnScore: newTurnScore, kniffelProgress: newKniffelProgress });
          roll(TOTAL_DICE, newKniffelProgress, newTurnScore);
          return;
        } else {
          if (isClassic) {
            const chain = chainRef.current.cards;
            if (chain.length > 0) chain[chain.length - 1].completed = true;
            chainRef.current.ended = 'banked';
          }
          // Committed + banked (like Stop & Score below) so the won game
          // survives a reload: the snapshot otherwise still held the
          // pre-win table, and restoring handed back dice that could reroll
          // — and bust away — a game already won.
          dispatch({ type: 'TABLE_COMMITTED', turnScore: newTurnScore, keptDice: newKeptDice, kniffelProgress: newKniffelProgress });
          setDisplayRoll([]);
          dispatch({ type: 'TURN_BANKED', summary: { won: true, score: newTurnScore, isTutto: true } });
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
        dispatch({ type: 'TABLE_COMMITTED', turnScore: newTurnScore, keptDice: newKeptDice, kniffelProgress: newKniffelProgress });
        setDisplayRoll([]);
        // Bank or draw was decided by which button was pressed — the summary
        // no longer asks a second time (it used to, under a heading that said
        // the turn had stopped). A draw the store refuses banks instead.
        if (action === 'draw' && drawNextCard(newTurnScore)) return;
        dispatch({ type: 'TURN_BANKED', summary: { won: true, score: newTurnScore, isTutto: true } });
        return;
      } else if (currentCard !== 'Feuerwerk') {
        // Modernized turn-ending tutto: committed + marked stopped (like the
        // classic branch above and Stop & Score below) so a reload restores
        // into this decided summary — not the pre-tutto table, where the
        // tutto could be rolled back and played on past the turn's end.
        // Spectators likewise see the banked total, not the stale board.
        dispatch({ type: 'TABLE_COMMITTED', turnScore: newTurnScore, keptDice: newKeptDice, kniffelProgress: newKniffelProgress });
        setDisplayRoll([]);
        dispatch({ type: 'TURN_BANKED', summary: { won: true, score: newTurnScore, isTutto: true } });
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
      dispatch({ type: 'TABLE_COMMITTED', turnScore: newTurnScore, keptDice: newKeptDice, kniffelProgress: newKniffelProgress });
      setDisplayRoll([]);
      dispatch({ type: 'TURN_BANKED', summary: { won: true, score: newTurnScore, isTutto } });
      return;
    }

    if (action === 'roll') {
      dispatch({
        type: 'ROLL_ON_COMMITTED', turnScore: newTurnScore,
        keptDice: isTutto ? [] : newKeptDice, kniffelProgress: newKniffelProgress,
      });
      roll(isTutto ? TOTAL_DICE : TOTAL_DICE - newKeptDice.length, newKniffelProgress, newTurnScore);
    }
  };

  // Official Feuerwerk keeps every scoring die — the forced selection made in
  // finalizeRoll (or re-applied on restore) must not be editable. Read by the
  // dice themselves as well as by the guard below, so the board cannot go on
  // offering a pointer cursor and a hover highlight for a click that toggleDie
  // is going to drop.
  const isSelectionLocked = isClassic && currentCard === 'Feuerwerk';

  const toggleDie = (id: string) => {
    if (bustState || showSummary || isRolling) return;
    if (isSelectionLocked) return;
    dispatch({ type: 'DIE_TOGGLED', id });
  };

  const selectAllValid = () => {
    if (bustState || showSummary || isRolling || !hasRolled) return;
    const validIndices = new Set(getMaxValidSelection(currentRoll.map(d => d.val), currentCard, kniffelProgress, ruleset));
    dispatch({ type: 'SELECTION_SET', indices: validIndices });
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
    dispatch({ type: 'CHAIN_DRAWN', card: newCard, base });
    setDisplayRoll([]);
    if (newCard === 'Stop') {
      chainRef.current.ended = 'stopCard';
      chainRef.current.forfeitedScore = base;
      playBuzzer();
      vibrateBust();
    } else {
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
      dispatch({ type: 'SUMMARY_SHOWN', summary: { won: false, score: 0, isTutto: false, stoppedByCard: true } });
    }
  }, [revealedCard]);

  // Whether currentCard has actually BEEN the drawn card since the draw.
  // drawCardMidTurn sets it locally before the push is even sent, so this turns
  // true within a render of the draw — which is what makes a later move off
  // that card readable as the store contradicting the draw rather than as its
  // update simply not having arrived yet.
  const drawnCardWasCurrentRef = useRef(false);

  useEffect(() => {
    const pending = pendingChainRollRef.current;
    if (!pending || currentCard !== pending.card) return;
    drawnCardWasCurrentRef.current = true;
    if (revealedCard) return;
    pendingChainRollRef.current = null;
    drawnCardWasCurrentRef.current = false;
    rollRef.current(TOTAL_DICE, [], pending.base);
  }, [currentCard, revealedCard]);

  // The drawn card is not coming (see DISCARDED_DRAW_RECOVERY_MS): the store
  // has settled back on the card the draw was made from, so there is nothing
  // to roll for. Fall back to what a draw the store refuses outright already
  // does — bank the tutto that was committed before it — and take the
  // optimistic push back out of the chain, which is still exactly the entry
  // this draw pushed: nothing else can push one while a draw is pending.
  //
  // The reveal goes with it. It announces a card the turn never got, and the
  // summary this lands on would otherwise sit behind it — counting down to the
  // end of the turn under a modal the player is still reading.
  const abandonDiscardedDraw = useCallback((base: number) => {
    pendingChainRollRef.current = null;
    drawnCardWasCurrentRef.current = false;
    chainRef.current.cards.pop();
    chainRef.current.ended = 'banked';
    setRevealedCard(null);
    dispatch({ type: 'DRAW_ABANDONED', summary: { won: true, score: base, isTutto: true } });
  }, []);

  // Declared after the release effect above so that, on the render where the
  // card does arrive, the release has already cleared the pending roll before
  // this one re-reads it — the deadline is dropped rather than left armed.
  useEffect(() => {
    const pending = pendingChainRollRef.current;
    if (!pending || currentCard === pending.card) return;
    // The store held the drawn card and has moved off it again: that push was
    // discarded and reverted, so waiting changes nothing. Recover on the spot,
    // reveal or no reveal — the revert usually lands while the player is still
    // reading the card it just took away from them.
    if (drawnCardWasCurrentRef.current) {
      abandonDiscardedDraw(pending.base);
      return;
    }
    // Nothing contradicting has arrived at all: a revert onto the very card the
    // draw was made from leaves this prop untouched and wakes no effect, so the
    // deadline is the only way out of that one.
    const timer = setTimeout(() => abandonDiscardedDraw(pending.base), DISCARDED_DRAW_RECOVERY_MS);
    return () => clearTimeout(timer);
    // revealedCard is not read above, but a draw sets it in the same batch as
    // the pending roll — a ref this effect cannot depend on. It is what wakes
    // this effect for the draw at all.
  }, [currentCard, revealedCard, abandonDiscardedDraw]);

  // The same discard, for a drawn STOP: it never arms the deferred roll, so
  // neither effect above watches it — but its push can be thrown away all the
  // same, and committing the forfeit then logs a Stop the server's deck still
  // holds and will deal again. Its contradiction has no deadline case, unlike
  // the playable-card one: the card a draw is made from can never itself be
  // Stop, so a revert always moves the prop off 'Stop'. Watched for as long
  // as the draw is on screen — the reveal, or the forfeit summary it leads to
  // (which a reload during the reveal restores straight into).
  //
  // Seen-current first, like drawnCardWasCurrentRef above: drawCardMidTurn
  // sets the store before the reveal can render, so production always shows
  // this effect 'Stop' before any revert — but only the sight of it makes a
  // later non-Stop prop MEAN a revert rather than an update that has not
  // arrived yet.
  const stopDrawSeenCurrentRef = useRef(false);
  const stopDrawShowing = revealedCard === 'Stop' || (showSummary && !!summaryData.stoppedByCard);
  useEffect(() => {
    if (!stopDrawShowing) {
      stopDrawSeenCurrentRef.current = false;
      return;
    }
    if (currentCard === 'Stop') {
      stopDrawSeenCurrentRef.current = true;
      return;
    }
    if (!stopDrawSeenCurrentRef.current) return;
    stopDrawSeenCurrentRef.current = false;
    // The tutto was committed before the draw, so the discarded draw banks it
    // — the exact fallback a draw the store refuses outright already takes.
    abandonDiscardedDraw(turnScore);
  }, [stopDrawShowing, currentCard, abandonDiscardedDraw, turnScore]);

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

  // The machine as of the most recent commit. Held in a ref, and updated by
  // an effect declared ahead of the ones that read it so it is already
  // current when they run. It exists for the two edge-triggered readers
  // below: the bust send has to happen on the bust edge and nowhere else
  // (depending on the fields directly would re-send the same final snapshot
  // every time one of them settled afterwards), and finishGame must stay a
  // stable callback while reading the summary the machine holds NOW. Because
  // the reducer commits every transition atomically, this one ref replaces
  // the separate bust-snapshot and summary-data mirrors it used to take to
  // read a consistent moment.
  const machineRef = useRef(machine);
  useEffect(() => { machineRef.current = machine; });

  useEffect(() => {
    if (!bustState || !onStateChangeRef.current || !hasRolled) return;
    const m = machineRef.current;
    onStateChangeRef.current(buildDiceSnapshot({
      turnScore: m.turnScore, keptDice: m.keptDice, currentRoll: m.currentRoll,
      kniffelProgress: m.kniffelProgress, tuttosThisTurn: m.tuttosThisTurn,
      busted: true, ...chainSnapshotFields(),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bustState, hasRolled]);

  const finishGame = useCallback(() => {
    const data = machineRef.current.summaryData;
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
    // The reducer replaces this object whenever the summary's CONTENTS change,
    // which a discarded draw does without ever closing the summary — see
    // restartKey. Identity is the signal; nothing reads the value here.
    restartKey: summaryData,
  });

  const isMakingTutto = keptDice.length + selectedRolls.length === TOTAL_DICE;

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

      <div className="px-8 pt-6 pb-8 sm:p-8 w-full flex-1 overflow-y-auto overscroll-contain">
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
            <TurnScoreHeader
              turnScore={turnScore}
              pendingSelectionScore={pendingSelectionScore}
              isClassic={isClassic}
              chainCardCount={chainCardCount}
              currentCard={currentCard}
              tuttosThisTurn={tuttosThisTurn}
            />

            <KeptDiceTray keptDice={displayKeptDice} />

            <CurrentRollBoard
              displayRoll={displayRoll}
              currentRoll={currentRoll}
              rollingDiceIndices={rollingDiceIndices}
              bustState={bustState}
              isRolling={isRolling}
              isSelectionLocked={isSelectionLocked}
              hasRolled={hasRolled}
              selectionValid={validation.valid}
              selectedCount={selectedRolls.length}
              onToggleDie={toggleDie}
              onSelectAllValid={selectAllValid}
            />

            <TurnActionBar
              show={hasRolled && !bustState}
              actionable={validation.valid && !isRolling}
              isRollAgainApplicable={isRollAgainApplicable}
              canStop={canStop}
              stopButtonText={stopButtonText}
              canDrawAfterTutto={canDrawAfterTutto}
              onAction={handleAction}
            />
          </>
        )}
      </div>
    </div>
  );
}
