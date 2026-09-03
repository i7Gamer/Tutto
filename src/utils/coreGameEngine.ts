import type {
  CardType,
  DiceSnapshot,
  InitialCards,
  Player,
  CoreGameState,
  NextTurnResult,
  UndoResult,
  HistoryEntry,
  HistoryEventType,
  TurnSummary,
  TurnCardPlayed,
} from '../types';
import { isSpecialCard } from './diceTurnControls';
// Re-exported below: buildGlobalStatsPayload/buildDeviceStatsPayload live in
// statsPayloads.ts (pure stats aggregation, no turn logic) but every existing
// caller imports them from here, so the public surface of this module is
// unchanged.
import { buildDeviceStatsPayload, buildGlobalStatsPayload } from './statsPayloads';

export { buildDeviceStatsPayload, buildGlobalStatsPayload };

// Awarded turn score for successfully completing these Yes/No cards — not
// incremental dice points, a fixed value the card itself defines. Exported
// because the classic chain path computes the turn total client-side
// (DiceGame) and must use the exact same values the engine awards.
export const PLUS_MINUS_SCORE = 1000;
export const KNIFFEL_SCORE = 2000;

// How a per-turn record a player has not set yet is carried in the pre-turn
// snapshot (NextTurnResult types those as plain numbers). Safe as a sentinel
// because the engine only ever writes a record that BEATS the previous value,
// which starts here — so no real record is ever 0, and calculateUndo can put
// back `undefined` ("no value yet", see playerStats.ts) instead of a
// manufactured zero.
const NO_RECORD_YET = 0;

const recordFromSnapshot = (snapshot: number): number | undefined =>
  snapshot === NO_RECORD_YET ? undefined : snapshot;

// A deck with every card type at 0 leaves currentCard permanently null and the
// game unplayable — both lobbies must refuse to start in that state.
export const hasPlayableDeck = (initialCards: InitialCards | undefined): boolean =>
  Object.values(initialCards ?? {}).some(count => (count ?? 0) > 0);

/**
 * The previous-turn bookkeeping in its "there is nothing to undo" state.
 *
 * These ten fields all describe the same single turn, so they move together:
 * calculateNextTurn fills them in as one set, calculateUndo consumes them as
 * one set, and every site that ends or discards a turn clears them as one set.
 * Written out once because there are five such sites across the client store
 * and the server room state, and clearing some but not all leaves a
 * half-erased turn — which is what server/rooms.ts's active-player removal did,
 * keeping a previousTurnSummary for a turn whose card and player it had just
 * dropped. Inert, since undo refuses without previousCard, but it rode every
 * subsequent broadcast.
 *
 * A factory, not a shared literal: the result lands in mutable store state and
 * in the server's room state (see createInitialLocalState for the same reason).
 *
 * `satisfies` rather than a return-type annotation, the same way
 * playerStats.ts checks its own field set: the annotation would widen
 * previousLeaders to Player[] | null, which the server's stricter
 * ServerPlayer[] | null then refuses — while every key is still checked
 * against CoreGameState, so a field added there fails to compile here.
 */
export const noUndoableTurn = () => ({
  previousCard: null,
  previousScore: null,
  previousLeaders: null,
  previousWasBust: false,
  // undefined, not false: the field holds "the outcome that was recorded, if
  // one was", and there is no turn here to have recorded anything. That is the
  // same value an entry predating the field carries, which is what
  // calculateUndo's compatibility fallback keys off — and it drops out of
  // JSON.stringify, so a save written now looks like one written then.
  previousWasSuccess: undefined,
  previousHighestTurnScore: 0,
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: null,
  previousTurnSummary: null,
} satisfies Partial<CoreGameState>);

export const shuffleArray = <T>(array: T[]): T[] => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

// Clusters of up to MAX_CLUSTER identical adjacent cards are acceptable; only
// runs longer than that are avoided.
const MAX_CLUSTER = 3;

// Builds the deck as a uniform random shuffle constrained to "no more than
// MAX_CLUSTER identical cards adjacent": each card is drawn randomly among the
// still-eligible types, weighted by remaining copies (sampling without
// replacement), with two interventions:
//   - a type that just completed a run of MAX_CLUSTER is ineligible for the
//     next slot (that's the constraint itself), and
//   - a type whose remaining copies no longer fit into the runs the other
//     remaining cards can separate (count > MAX_CLUSTER * othersLeft) MUST be
//     placed now — deferring it once more would force an over-long run later.
//     At most one type can ever be in this state (two would need more cards
//     than remain), so the rule is unambiguous. A pure most-plentiful-first
//     greedy also satisfies the constraint but deterministically front-loads
//     the most common card type, which is why it isn't used here.
// If a card type so dominates the deck that MAX_CLUSTER is mathematically
// unsatisfiable (e.g. one type outnumbering all others combined), every type
// eventually becomes ineligible and we fall back to placing the blocked one
// anyway rather than getting stuck.
export const buildDeck = (initialCards: InitialCards): CardType[] => {
  const remaining = new Map<CardType, number>();
  (Object.keys(initialCards) as CardType[]).forEach(cardType => {
    const count = initialCards[cardType] ?? 0;
    if (count > 0) remaining.set(cardType, count);
  });

  const deckSize = Array.from(remaining.values()).reduce((sum, c) => sum + c, 0);
  let remainingTotal = deckSize;
  const deck: CardType[] = [];
  let lastCard: CardType | null = null;
  let runLength = 0;

  while (deck.length < deckSize) {
    const blocked: CardType | null = runLength >= MAX_CLUSTER ? lastCard : null;
    let candidates: [CardType, number][] = Array.from(remaining.entries()).filter(([type, count]) => count > 0 && type !== blocked);
    if (candidates.length === 0) candidates = Array.from(remaining.entries()).filter(([, count]) => count > 0);

    const forced = candidates.find(([, count]) => count > MAX_CLUSTER * (remainingTotal - count));

    let chosen: CardType;
    if (forced) {
      chosen = forced[0];
    } else {
      const candidateTotal = candidates.reduce((sum, [, count]) => sum + count, 0);
      let pick = Math.floor(Math.random() * candidateTotal);
      chosen = candidates[candidates.length - 1][0];
      for (const [type, count] of candidates) {
        pick -= count;
        if (pick < 0) { chosen = type; break; }
      }
    }

    deck.push(chosen);
    remaining.set(chosen, (remaining.get(chosen) ?? 0) - 1);
    remainingTotal--;
    runLength = chosen === lastCard ? runLength + 1 : 1;
    lastCard = chosen;
  }

  return deck;
};

export const computeRankedPlayers = (players: Player[]): Player[] => {
  const sorted = [...players].map(p => ({ ...p })).sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    if (i > 0 && p.score === sorted[i - 1].score) {
      p.position = sorted[i - 1].position;
    } else {
      p.position = i + 1;
    }
  });
  return sorted;
};

export const getLeaders = (players: Player[]): Player[] => {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return [];
  const topScore = sorted[0].score;
  return sorted.filter(p => p.score === topScore);
};

// One row per playable card naming the single counter a card played in a
// classic chain bumps, and — for the four cards whose counter depends on the
// outcome — which side of `completed` it is. applySummaryCounters and
// revertSummaryCounters both walk this table (with delta +1 / -1) instead of
// each hand-rolling its own `switch (played.card)`, which is what let the two
// drift from each other before.
//
// Kleeblatt only ever contributes a FAILURE entry here: a completed Kleeblatt
// is the instant win, handled entirely by the caller's separate branch, so
// counting it here too would double it.
const CARD_COUNTER_DELTAS: Partial<Record<CardType, (played: TurnCardPlayed) => keyof Player | null>> = {
  Feuerwerk: () => 'timesFeuerwerkReceived',
  x2: () => 'timesx2Received',
  Stop: () => 'timesSkipped',
  Kniffel: played => (played.completed ? 'timesKniffelCompleted' : 'timesKniffelFailed'),
  Plus_Minus: played => (played.completed ? 'timesPlusMinusCompleted' : 'timesPlusMinusFailed'),
  Kleeblatt: played => (played.completed ? null : 'timesKleeblattFailed'),
};

// Applies (delta > 0) or reverses (delta < 0) one card's counter bump.
// Reversal clamps at 0 the same way every hand-written `Math.max(0, ...)` in
// this file already did — a counter can be replayed onto a roster that
// changed since (leave/kick/reconnect), so it must never go negative.
const bumpCardCounter = (player: Player, played: TurnCardPlayed, delta: number): void => {
  const field = CARD_COUNTER_DELTAS[played.card]?.(played);
  if (!field) return;
  const current = (player[field] as number | undefined) ?? 0;
  (player[field] as number) = delta < 0 ? Math.max(0, current + delta) : current + delta;
};

// The classic chain's per-turn counters: the bust flag, the two classic
// records (mostCardsInTurn / highestForfeitedTurnScore, their pre-turn values
// stashed on the summary for revertSummaryCounters to restore), and every
// per-card counter from turnSummary.cards. Mutates currentPlayer and
// summaryForState in place; returns whether the turn was a (dice) bust.
//
// Deliberately does NOT touch feuerwerkBusts/x2Busts or any per-card
// point/turn-score attribution: "which card the chain died on" has no
// counterpart in the modernized stats, and the classic buckets never display
// them.
const applySummaryCounters = (currentPlayer: Player, summaryForState: TurnSummary, isSuccess: boolean): boolean => {
  const wasBust = summaryForState.ended === 'null';
  if (wasBust) currentPlayer.busts = (currentPlayer.busts ?? 0) + 1;

  // Pre-turn values ride the stored summary so revertSummaryCounters can
  // restore them without another round of previous* plumbing on CoreGameState.
  summaryForState.prevMostCardsInTurn = currentPlayer.mostCardsInTurn ?? null;
  summaryForState.prevHighestForfeitedTurnScore = currentPlayer.highestForfeitedTurnScore ?? null;
  currentPlayer.totalTuttos = (currentPlayer.totalTuttos ?? 0) + summaryForState.tuttoCount;
  if (summaryForState.cards.length > (currentPlayer.mostCardsInTurn ?? 0)) {
    currentPlayer.mostCardsInTurn = summaryForState.cards.length;
  }
  if (!isSuccess && (summaryForState.forfeitedScore ?? 0) > (currentPlayer.highestForfeitedTurnScore ?? 0)) {
    currentPlayer.highestForfeitedTurnScore = summaryForState.forfeitedScore;
  }

  for (const played of summaryForState.cards) bumpCardCounter(currentPlayer, played, 1);

  return wasBust;
};

// The exact reversal of applySummaryCounters, mirrored card-for-card via the
// same CARD_COUNTER_DELTAS table (delta -1). Does not touch score or the
// Plus/Minus deduction records (previousLeaders / deductedPlayers) — those
// span every player, not just this one, and stay inline in calculateUndo
// beside applyClassicPlusMinus's forward counterpart.
const revertSummaryCounters = (p: Player, previousTurnSummary: TurnSummary): void => {
  if (previousTurnSummary.ended === 'null') p.busts = Math.max(0, (p.busts ?? 0) - 1);

  for (const played of previousTurnSummary.cards) bumpCardCounter(p, played, -1);

  p.totalTuttos = Math.max(0, (p.totalTuttos ?? 0) - previousTurnSummary.tuttoCount);
  if (previousTurnSummary.prevMostCardsInTurn !== undefined) {
    p.mostCardsInTurn = previousTurnSummary.prevMostCardsInTurn ?? undefined;
  }
  if (previousTurnSummary.prevHighestForfeitedTurnScore !== undefined) {
    p.highestForfeitedTurnScore = previousTurnSummary.prevHighestForfeitedTurnScore ?? undefined;
  }
};

// Atomic Plus/Minus: the ±1000s resolve only when the turn actually banks —
// a later null/Stop forfeits them along with everything else. Replayed card
// by card in the order the chain played them: at each one the current player
// counts as holding everything the chain had earned by that point
// (plusMinusScores), and the leaders are recomputed from the deductions
// already applied. Comparing against the bare pre-turn score instead kept
// deducting after the chain had already overtaken the leader.
//
// EVERY tied leader loses 1000 — the roller among them for deciding WHO
// leads, but excluded from paying: "If more than one player is leading with
// the same number of points, each of them has 1,000 points deducted… If it
// is the leading player who reveals this card, naturally they don't have to
// deduct any points from their score" (ABACUSSPIELE 2024). So the roller is
// filtered out of the victims rather than cancelling the whole deduction,
// which is what lets a CO-leader's 1000 land; a sole leader filters down to
// nobody, the same rule falling out of it. The modernized path (inline in
// calculateNextTurn) deliberately keeps its older all-or-nothing reading.
//
// Mutates newPlayers' scores/times1000PointsDeducted in place; returns null
// when nobody was actually deducted (nothing to snapshot or record).
const applyClassicPlusMinus = (
  newPlayers: Player[],
  currentPlayer: Player,
  turnSummary: TurnSummary,
): { snapshotLeaders: Player[]; deductedPlayers: string[]; deductedAmounts: number[] } | null => {
  const preScores = new Map<string, Player>();
  const deducted: string[] = [];
  // Parallel to `deducted`: what each hit really took off. Recorded here
  // because it cannot be recomputed later — once the scores have moved,
  // nothing left in the entry says whether the floor swallowed part of it.
  const deductedAmounts: number[] = [];

  for (const scoreBeforeCard of turnSummary.plusMinusScores) {
    const asOfThisCard = newPlayers.map(p => (
      p.name === currentPlayer.name ? { ...p, score: p.score + scoreBeforeCard } : p
    ));
    const victims = getLeaders(asOfThisCard).filter(l => l.name !== currentPlayer.name);
    victims.forEach(l => {
      const p = newPlayers.find(np => np.name === l.name);
      if (!p) return;
      // Official rule: "a player can never have less than 0 points" —
      // clamped here (classic) only; the modernized path keeps its
      // long-standing negative-scores behavior.
      const clamped = Math.max(0, p.score - PLUS_MINUS_SCORE);
      // A leader already sitting on 0 loses nothing, and an untouched score
      // is not a deduction to record, display or undo. This is not
      // hypothetical: before anyone has scored, EVERY player is tied on 0,
      // so the game's first Plus/Minus would otherwise report the whole
      // table as deducted while changing nobody's score.
      if (clamped === p.score) return;
      // First touch snapshots the true pre-commit score, so undo can restore
      // absolutely however many deductions follow.
      if (!preScores.has(p.name)) preScores.set(p.name, { ...p });
      p.times1000PointsDeducted = (p.times1000PointsDeducted ?? 0) + 1;
      deductedAmounts.push(p.score - clamped);
      p.score = clamped;
      deducted.push(p.name);
    });
  }

  if (deducted.length === 0) return null;
  return { snapshotLeaders: [...preScores.values()], deductedPlayers: deducted, deductedAmounts };
};

// Builds the log line for one turn: the base fields every turn carries, plus
// the classic chain's card list / per-deduction amounts when present, falling
// back to the modernized path's plain deductedPlayers-by-name when a bare
// Plus/Minus (no turnSummary) triggered a deduction.
const buildHistoryEntry = (
  round: number,
  currentPlayer: Player,
  historyCard: CardType,
  historyType: HistoryEventType,
  currentCard: CardType | null,
  isSuccess: boolean,
  turnScore: number,
  turnSummary: TurnSummary | undefined,
  summaryForState: TurnSummary | null,
  snapshotLeaders: Player[] | null,
): HistoryEntry => {
  const historyEntry: HistoryEntry = {
    // round-player-totalTurns is already a unique triple (totalTurns strictly
    // increments per player each turn) — no random suffix needed.
    id: `${round}-${currentPlayer.name}-${currentPlayer.totalTurns}`,
    round,
    playerName: currentPlayer.name,
    playerColor: currentPlayer.color,
    card: historyCard,
    type: historyType,
    score: currentCard === 'Kleeblatt' && isSuccess ? 0 : turnScore,
  };

  if (summaryForState && summaryForState.cards.length > 1) {
    historyEntry.cards = summaryForState.cards.map(c => c.card);
  }
  if (summaryForState?.deductedPlayers?.length) {
    historyEntry.deductedPlayers = [...summaryForState.deductedPlayers];
    // Both lists or neither: the log reads them by index. The modernized
    // branch carries no amounts — it never clamps, so the flat
    // PLUS_MINUS_SCORE summarizeDeductions falls back to is the true one.
    if (summaryForState.deductedAmounts) historyEntry.deductedAmounts = [...summaryForState.deductedAmounts];
  } else if (!turnSummary && currentCard === 'Plus_Minus' && isSuccess && snapshotLeaders) {
    historyEntry.deductedPlayers = snapshotLeaders.map(l => l.name);
  }

  return historyEntry;
};

interface HighestTurnScoreSnapshot {
  previousHighestTurnScore: number;
  previousHighestFeuerwerkTurnScore: number;
  previousHighestX2TurnScore: number;
}

// Card-agnostic and per-card ("a Feuerwerk turn", "an x2 turn") turn-score
// maxima. The per-card records are a modernized-only concept — in a classic
// chain the turn spans several cards, so "a Feuerwerk turn's score" is
// ill-defined — hence the `!turnSummary` gates. Neither record is gated on
// wasBust: a busted turn's score still counts toward it, the same way the
// card-agnostic one already did (pinned down explicitly by a unit test).
// Returns the PRE-turn values, which the caller hands back as
// NextTurnResult.previousHighest*TurnScore for calculateUndo to restore.
const applyHighestTurnScoreRecords = (
  currentPlayer: Player,
  turnScore: number,
  currentCard: CardType | null,
  turnSummary: TurnSummary | undefined,
): HighestTurnScoreSnapshot => {
  const previousHighestTurnScore = currentPlayer.highestTurnScore ?? NO_RECORD_YET;
  const previousHighestFeuerwerkTurnScore = currentPlayer.highestFeuerwerkTurnScore ?? NO_RECORD_YET;
  const previousHighestX2TurnScore = currentPlayer.highestX2TurnScore ?? NO_RECORD_YET;

  if (turnScore > previousHighestTurnScore) currentPlayer.highestTurnScore = turnScore;
  if (!turnSummary && currentCard === 'Feuerwerk' && turnScore > previousHighestFeuerwerkTurnScore) {
    currentPlayer.highestFeuerwerkTurnScore = turnScore;
  }
  if (!turnSummary && currentCard === 'x2' && turnScore > previousHighestX2TurnScore) {
    currentPlayer.highestX2TurnScore = turnScore;
  }

  return { previousHighestTurnScore, previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore };
};

// A completed Kleeblatt is a binary instant win, not a scored turn — the dice
// rolled to complete it (turnScore/scoreInput) are never added to the score,
// matching the physical-dice rules (no separate scoring for it). The score
// just needs to (a) clear winningScore and (b) strictly exceed every other
// player's, so this player is the sole leader — a synthetic "999999" sentinel
// score used to do this by discarding the real score entirely, which
// corrupted average-score stats (totalScore, dashboards) whenever a Kleeblatt
// game was included.
//
// Returns the short-circuit NextTurnResult calculateNextTurn returns
// immediately on a win, or null when this turn isn't one (the caller falls
// through to the ordinary scoring/advance path).
const resolveKleeblattWin = (
  newPlayers: Player[],
  currentPlayer: Player,
  currentCard: CardType | null,
  isSuccess: boolean,
  winningScore: number,
  turnScore: number,
  wasBust: boolean,
  snapshotLeaders: Player[] | null,
  summaryForState: TurnSummary | null,
  cards: CardType[],
  round: number,
  historyEntry: HistoryEntry,
): NextTurnResult | null => {
  if (currentCard !== 'Kleeblatt' || !isSuccess) return null;

  currentPlayer.timesKleeblattCompleted = (currentPlayer.timesKleeblattCompleted ?? 0) + 1;
  const otherScores = newPlayers.filter(p => p.name !== currentPlayer.name).map(p => p.score);
  const highestOtherScore = otherScores.length > 0 ? Math.max(...otherScores) : -Infinity;
  currentPlayer.score = Math.max(winningScore, currentPlayer.score, highestOtherScore + 1);

  return {
    players: newPlayers, isGameOver: true, isRoundEnd: true,
    nextIndex: null, nextRound: round,
    previousCard: currentCard, previousScore: turnScore,
    previousLeaders: snapshotLeaders, previousWasBust: wasBust,
    previousWasSuccess: isSuccess,
    previousHighestTurnScore: currentPlayer.highestTurnScore ?? NO_RECORD_YET,
    previousHighestFeuerwerkTurnScore: currentPlayer.highestFeuerwerkTurnScore ?? NO_RECORD_YET,
    previousHighestX2TurnScore: currentPlayer.highestX2TurnScore ?? NO_RECORD_YET,
    previousPlayerName: currentPlayer.name,
    previousTurnSummary: summaryForState,
    newDeck: cards, drawnCard: null,
    historyEntry,
  };
};

interface TurnOrderAdvance {
  isGameOver: boolean;
  isRoundEnd: boolean;
  nextIndex: number | null;
  nextRound: number;
  newDeck: CardType[];
  drawnCard: CardType | null;
}

// Moves to the next seat (wrapping into the next round at the end of one),
// decides whether that wrap also ends the game, and draws the next card —
// rebuilding the deck first if it's empty. Returns `nextIndex: null` exactly
// when the game just ended, matching calculateNextTurn's own contract.
const advanceTurnOrder = (
  newPlayers: Player[],
  currentPlayerIndex: number,
  round: number,
  winningScore: number,
  cards: CardType[],
  initialCards: InitialCards,
): TurnOrderAdvance => {
  let isGameOver = false;
  let nextIndex: number | null = currentPlayerIndex + 1;
  let nextRound = round;
  let isRoundEnd = false;

  if (nextIndex >= newPlayers.length) {
    isRoundEnd = true;
    const currentLeaders = getLeaders(newPlayers);
    if (currentLeaders[0].score >= winningScore && currentLeaders.length === 1) {
      isGameOver = true;
    }
    if (!isGameOver) { nextIndex = 0; nextRound++; }
  }

  let newDeck = [...cards];
  let drawnCard: CardType | null = null;

  if (!isGameOver) {
    if (newDeck.length === 0) newDeck = buildDeck(initialCards);
    drawnCard = newDeck.shift() ?? null;
  } else {
    nextIndex = null;
  }

  return { isGameOver, isRoundEnd, nextIndex, nextRound, newDeck, drawnCard };
};

export const calculateNextTurn = (
  gameState: CoreGameState & { currentPlayerIndex: number },
  scoreInput: number,
  isSuccess = false,
  turnSummary?: TurnSummary,
  // Set only by server/turnTimers.ts: this commit was forced by the server's
  // turn clock expiring, not a player action. It changes nothing about the
  // scoring/counters — those already read the outcome from isSuccess/
  // turnSummary.ended — only which HistoryEventType a turn that would
  // otherwise default to 'success' gets logged as (see historyType below):
  // a "decided but never confirmed" modernized turn (Stop & Score / a
  // turn-ending tutto whose auto-continue never fired) forfeits its points to
  // the clock, so logging it as a plain success ("scored 0 pts") would be
  // read as an ordinary turn rather than a timeout.
  isTimeout = false,
): NextTurnResult => {
  const { players, currentPlayerIndex, currentCard, round, winningScore, cards, initialCards } = gameState;

  let turnScore = Number.isFinite(scoreInput) ? scoreInput : 0;
  const newPlayers = players.map(p => ({ ...p }));
  const currentPlayer = newPlayers[currentPlayerIndex];
  let snapshotLeaders: Player[] | null = null;
  let summaryForState: TurnSummary | null = null;

  currentPlayer.totalTurns = (currentPlayer.totalTurns ?? 0) + 1;

  let wasBust: boolean;
  let historyType: HistoryEventType;
  let historyCard: CardType;

  if (turnSummary) {
    // ── Classic path: the summary owns every per-card counter and the score
    // arrives fully computed by the playing client (straight +2000,
    // Plus/Minus +1000 per success, bonus added, x2 doubling applied).
    summaryForState = { ...turnSummary, cards: turnSummary.cards.map(c => ({ ...c })) };

    wasBust = applySummaryCounters(currentPlayer, summaryForState, isSuccess);

    if (isSuccess && turnSummary.plusMinusScores.length > 0) {
      const deduction = applyClassicPlusMinus(newPlayers, currentPlayer, turnSummary);
      if (deduction) {
        snapshotLeaders = deduction.snapshotLeaders;
        summaryForState.deductedPlayers = deduction.deductedPlayers;
        summaryForState.deductedAmounts = deduction.deductedAmounts;
      }
    }

    // The chain's own `ended` already distinguishes a genuine dice bust
    // ('null', charged above) from the server clock forfeiting a completed-
    // but-uncommitted card ('timeout', never charged) — see TURN_ENDS in
    // types.ts. historyType must track that same distinction, or the log
    // prints "busted on X" for a turn no bust was ever charged for.
    historyType = isSuccess ? 'success' : (summaryForState.ended === 'timeout' ? 'timeout' : 'bust');
    historyCard = turnSummary.cards[0]?.card ?? currentCard ?? 'Stop';
  } else {
    // ── Modernized path (also the server-timeout forfeit) — unchanged.
    wasBust = !isSuccess && !isSpecialCard(currentCard) && currentCard !== 'Stop';
    if (wasBust) {
      currentPlayer.busts = (currentPlayer.busts ?? 0) + 1;
      if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkBusts = (currentPlayer.feuerwerkBusts ?? 0) + 1;
      if (currentCard === 'x2') currentPlayer.x2Busts = (currentPlayer.x2Busts ?? 0) + 1;
    }

    if (currentCard === 'Plus_Minus' && isSuccess) {
      turnScore = PLUS_MINUS_SCORE;
      const leaders = getLeaders(newPlayers);
      const isLeader = leaders.find(l => l.name === currentPlayer.name);
      if (!isLeader) {
        snapshotLeaders = leaders.map(l => ({ ...l }));
        leaders.forEach(l => {
          const p = newPlayers.find(np => np.name === l.name);
          if (p) { p.times1000PointsDeducted = (p.times1000PointsDeducted ?? 0) + 1; p.score -= PLUS_MINUS_SCORE; }
        });
      }
      currentPlayer.timesPlusMinusCompleted = (currentPlayer.timesPlusMinusCompleted ?? 0) + 1;
    } else if (currentCard === 'Plus_Minus') {
      currentPlayer.timesPlusMinusFailed = (currentPlayer.timesPlusMinusFailed ?? 0) + 1;
    }

    if (currentCard === 'x2') currentPlayer.timesx2Received = (currentPlayer.timesx2Received ?? 0) + 1;
    if (currentCard === 'Feuerwerk') currentPlayer.timesFeuerwerkReceived = (currentPlayer.timesFeuerwerkReceived ?? 0) + 1;
    if (currentCard === 'Stop') currentPlayer.timesSkipped = (currentPlayer.timesSkipped ?? 0) + 1;

    if (currentCard === 'Kniffel' && isSuccess) {
      turnScore = KNIFFEL_SCORE;
      currentPlayer.timesKniffelCompleted = (currentPlayer.timesKniffelCompleted ?? 0) + 1;
    } else if (currentCard === 'Kniffel') {
      currentPlayer.timesKniffelFailed = (currentPlayer.timesKniffelFailed ?? 0) + 1;
    }

    // A special card is worth its fixed value or nothing — the dice rolled
    // toward one never score on their own. The success branches above already
    // override whatever the caller passed; a failure did not, so a caller
    // handing over a score for a card that was FAILED had it banked. No caller
    // does today (every failure path commits 0), which is exactly why the rule
    // belongs here rather than in each of them.
    if (isSpecialCard(currentCard) && !isSuccess) turnScore = 0;

    if (currentCard === 'x2') currentPlayer.x2PointsScored = (currentPlayer.x2PointsScored ?? 0) + turnScore;
    if (currentCard === 'Feuerwerk') currentPlayer.feuerwerkPointsScored = (currentPlayer.feuerwerkPointsScored ?? 0) + turnScore;

    historyType = 'success';
    if (currentCard === 'Stop') {
      historyType = 'skip';
    } else if (wasBust) {
      historyType = 'bust';
    } else if (isSpecialCard(currentCard)) {
      historyType = isSuccess ? 'success' : 'fail';
    } else if (isTimeout) {
      // Every other branch above already means something more specific than
      // "ran out of time" (a real bust, a Stop skip, a special card's own
      // outcome) and takes priority. What's left is exactly the "decided but
      // never confirmed" turn turnTimers.ts forfeits at 0 — logging it as the
      // default 'success' would print "scored 0 pts" for points the clock
      // took, not the player.
      historyType = 'timeout';
    }
    historyCard = currentCard ?? 'Stop';
  }

  const historyEntry = buildHistoryEntry(
    round, currentPlayer, historyCard, historyType, currentCard, isSuccess,
    turnScore, turnSummary, summaryForState, snapshotLeaders,
  );

  const kleeblattWin = resolveKleeblattWin(
    newPlayers, currentPlayer, currentCard, isSuccess, winningScore, turnScore,
    wasBust, snapshotLeaders, summaryForState, cards, round, historyEntry,
  );
  if (kleeblattWin) return kleeblattWin;
  if (currentCard === 'Kleeblatt' && !turnSummary) {
    // Summary path already counted the failure from summary.cards.
    currentPlayer.timesKleeblattFailed = (currentPlayer.timesKleeblattFailed ?? 0) + 1;
  }

  const { previousHighestTurnScore, previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore } =
    applyHighestTurnScoreRecords(currentPlayer, turnScore, currentCard, turnSummary);
  currentPlayer.score += turnScore;

  const advance = advanceTurnOrder(newPlayers, currentPlayerIndex, round, winningScore, cards, initialCards);

  return {
    players: newPlayers, isGameOver: advance.isGameOver, isRoundEnd: advance.isRoundEnd,
    nextIndex: advance.nextIndex,
    nextRound: advance.nextRound, previousCard: currentCard, previousScore: turnScore,
    previousLeaders: snapshotLeaders, previousWasBust: wasBust,
    previousWasSuccess: isSuccess,
    previousHighestTurnScore, previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
    previousPlayerName: currentPlayer.name,
    previousTurnSummary: summaryForState,
    newDeck: advance.newDeck, drawnCard: advance.drawnCard,
    historyEntry,
  };
};

// The exact reversal of the modernized branch of calculateNextTurn.
// previousLeaders/deductedPlayers span every player a Plus/Minus success
// deducted from, not just the one whose turn is being undone, so this takes
// the whole roster rather than a single Player (mirroring why
// applyClassicPlusMinus's classic counterpart does the same).
const revertModernizedCounters = (
  newPlayers: Player[],
  p: Player,
  previousCard: CardType,
  previousScore: number | null,
  previousWasBust: boolean,
  previousLeaders: Player[] | null,
  wasCompleted: (fixedScore: number) => boolean,
): void => {
  if (previousCard === 'Feuerwerk') p.timesFeuerwerkReceived = Math.max(0, (p.timesFeuerwerkReceived ?? 0) - 1);

  if (previousWasBust && !isSpecialCard(previousCard)) {
    p.busts = Math.max(0, (p.busts ?? 0) - 1);
    if (previousCard === 'Feuerwerk') p.feuerwerkBusts = Math.max(0, (p.feuerwerkBusts ?? 0) - 1);
    if (previousCard === 'x2') p.x2Busts = Math.max(0, (p.x2Busts ?? 0) - 1);
  }

  if (previousCard === 'Feuerwerk') p.feuerwerkPointsScored = Math.max(0, (p.feuerwerkPointsScored ?? 0) - (previousScore ?? 0));
  if (previousCard === 'x2') p.x2PointsScored = Math.max(0, (p.x2PointsScored ?? 0) - (previousScore ?? 0));

  if (previousCard === 'Plus_Minus' && previousLeaders) {
    previousLeaders.forEach(pl => {
      const actual = newPlayers.find(np => np.name === pl.name);
      if (actual) {
        actual.score = pl.score;
        actual.times1000PointsDeducted = Math.max(0, (actual.times1000PointsDeducted ?? 0) - 1);
      }
    });
  }

  if (previousCard === 'Plus_Minus') {
    if (wasCompleted(PLUS_MINUS_SCORE)) p.timesPlusMinusCompleted = Math.max(0, (p.timesPlusMinusCompleted ?? 0) - 1);
    else p.timesPlusMinusFailed = Math.max(0, (p.timesPlusMinusFailed ?? 0) - 1);
  }

  if (previousCard === 'x2') p.timesx2Received = Math.max(0, (p.timesx2Received ?? 0) - 1);

  if (previousCard === 'Kniffel') {
    if (wasCompleted(KNIFFEL_SCORE)) p.timesKniffelCompleted = Math.max(0, (p.timesKniffelCompleted ?? 0) - 1);
    else p.timesKniffelFailed = Math.max(0, (p.timesKniffelFailed ?? 0) - 1);
  }

  // A Kleeblatt completion instantly wins the game, which makes it un-undoable
  // (the finished/currentPlayerIndex guards in calculateUndo return null
  // first) — so a reachable Kleeblatt undo always reverses a failure.
  if (previousCard === 'Kleeblatt') {
    p.timesKleeblattFailed = Math.max(0, (p.timesKleeblattFailed ?? 0) - 1);
  }
};

// The subset of CoreGameState canUndoState's guards actually read — narrowed
// so a caller with only a partial slice of the store (Game.tsx's useShallow
// selector, which has no reason to carry previousScore/historyLog/etc. just
// for this check) can pass it straight through instead of assembling a fake
// full CoreGameState around it.
type UndoEligibilityState = Pick<
  CoreGameState,
  'players' | 'currentPlayerIndex' | 'round' | 'previousCard' | 'previousPlayerName' | 'previousTurnSummary' | 'finished'
>;

// Whether calculateUndo would succeed on this state, without doing any of the
// reversal work — the single source of truth for "is there a turn to undo"
// shared by calculateUndo's own early-outs (below) and any UI eligibility
// check (Game.tsx's Undo button). The two used to keep separate guard lists;
// the UI's copy fell behind and could show Undo enabled for a previous player
// no longer in the roster, which calculateUndo would then silently refuse —
// a click that does nothing. Kept in perfect sync now because calculateUndo
// itself calls this instead of re-checking.
export const canUndoState = (gameState: UndoEligibilityState): boolean => {
  const { players, currentPlayerIndex, round, previousCard, previousPlayerName, previousTurnSummary } = gameState;

  if (gameState.finished) return false;
  // A bare Stop turn (type 'skip') commits totalTurns and timesSkipped and stays
  // un-undoable. A classic chain that ENDED on a drawn Stop, however, forfeited
  // real points and mutated counters — its summary makes it undoable like any bust.
  if (!previousCard || (previousCard === 'Stop' && !previousTurnSummary)) return false;
  if (currentPlayerIndex === null) return false;
  if (!previousPlayerName) return false;

  // Looked up by name (not "currentPlayerIndex - 1") so a roster change since
  // that turn — a leave, kick, or reconnect-timeout removal — can't make this
  // land on the wrong player. If the player who took that turn is no longer in
  // the game at all, there is no one to safely revert the turn onto.
  const prevIndex = players.findIndex(p => p.name === previousPlayerName);
  if (prevIndex === -1) return false;

  // Under normal play the previous player sits right before the current one
  // (prevIndex === currentPlayerIndex - 1). If instead they're at or after the
  // current index, turn order must have wrapped since their turn, so the round
  // that wrap advanced needs to be undone too — impossible before round 1.
  if (prevIndex >= currentPlayerIndex && round <= 1) return false;

  return true;
};

/**
 * What calculateUndo reads: the core game state PLUS the live snapshot of the
 * turn currently in progress.
 *
 * liveTurnState is store/room state rather than part of CoreGameState (it is
 * relayed on its own socket event, several times a second, and is never
 * saved), but undo cannot restore the deck without it — see
 * inProgressChainCards below. Optional, so every existing caller that only has
 * a CoreGameState still type-checks and simply gets the no-live-chain
 * behaviour.
 */
export type UndoInputState = CoreGameState & { liveTurnState?: DiceSnapshot | null };

/**
 * The cards the turn IN PROGRESS has already taken off the deck, in draw order.
 *
 * A classic chain reveals another card on every tutto (drawCardMidTurn shifts
 * it off `cards` and makes it currentCard), so the deck is missing the whole
 * chain by the time an undo discards that turn — not just the card in play.
 * Putting back only currentCard, as this used to, lost every earlier card of
 * the chain from the deck for the rest of the game. cardsThisTurn is the only
 * record of them; by construction its last entry IS currentCard.
 *
 * Which is also the trust check: liveTurnState is a snapshot relayed from
 * whichever client is playing and can lag a draw, or describe a turn the store
 * has already moved past. A list that does not end on currentCard describes
 * some other moment, so it is ignored in favour of the card in play alone.
 */
export const inProgressChainCards = (
  currentCard: CardType | null,
  liveTurnState: DiceSnapshot | null | undefined,
): CardType[] => {
  if (!currentCard) return [];
  const chain = liveTurnState?.cardsThisTurn;
  if (chain && chain.length > 0 && chain[chain.length - 1] === currentCard) return [...chain];
  return [currentCard];
};

export const calculateUndo = (gameState: UndoInputState): UndoResult | null => {
  const {
    players, currentPlayerIndex, round, previousCard, previousScore,
    previousLeaders, previousWasBust, previousWasSuccess, previousHighestTurnScore,
    previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore, previousPlayerName,
    previousTurnSummary, currentCard, cards, liveTurnState,
  } = gameState;

  // Whether the previous turn's card was completed. Read from the outcome
  // calculateNextTurn recorded; the score comparison is the compatibility path
  // for entries written before that field existed (see previousWasSuccess in
  // types.ts) — it is wrong for a failure worth exactly `fixedScore`, which is
  // why the flag exists, but it is what those entries were committed under.
  const wasCompleted = (fixedScore: number): boolean =>
    previousWasSuccess ?? (previousScore === fixedScore);

  if (!canUndoState(gameState)) return null;
  // canUndoState guarantees currentPlayerIndex is non-null, previousCard is
  // non-null, and previousPlayerName is in the roster — asserted here rather
  // than re-checked (TS cannot narrow a destructured field across a call to a
  // plain boolean-returning function), so the two guard lists cannot drift
  // apart.
  const activeIndex = currentPlayerIndex as number;
  const definitePreviousCard = previousCard as CardType;

  const newPlayers = players.map(p => ({ ...p }));
  const prevIndex = newPlayers.findIndex(p => p.name === previousPlayerName);

  let newRound = round;
  let isRoundEndUndo = false;
  // Under normal play the previous player sits right before the current one
  // (prevIndex === currentPlayerIndex - 1). If instead they're at or after the
  // current index, turn order must have wrapped since their turn, so the round
  // that wrap advanced needs to be undone too. canUndoState already refused
  // this wrap when round <= 1, so a round to unwind is guaranteed here.
  if (prevIndex >= activeIndex) {
    newRound--;
    isRoundEndUndo = true;
  }

  const p = newPlayers[prevIndex];

  p.totalTurns = Math.max(0, (p.totalTurns ?? 0) - 1);

  if (previousTurnSummary) {
    // ── Classic chain reversal: mirror applySummaryCounters exactly via the
    // same per-card delta table. The Plus/Minus deduction reversal
    // (previousLeaders/deductedPlayers) spans every player, not just this
    // one, so it stays here rather than inside revertSummaryCounters.
    revertSummaryCounters(p, previousTurnSummary);

    if (previousLeaders) {
      previousLeaders.forEach(pl => {
        const actual = newPlayers.find(np => np.name === pl.name);
        if (actual) actual.score = pl.score;
      });
    }
    for (const name of previousTurnSummary.deductedPlayers ?? []) {
      const actual = newPlayers.find(np => np.name === name);
      if (actual) actual.times1000PointsDeducted = Math.max(0, (actual.times1000PointsDeducted ?? 0) - 1);
    }
  } else {
    revertModernizedCounters(newPlayers, p, definitePreviousCard, previousScore, previousWasBust, previousLeaders, wasCompleted);
  }

  if (previousHighestTurnScore !== undefined) p.highestTurnScore = recordFromSnapshot(previousHighestTurnScore);
  if (previousHighestFeuerwerkTurnScore !== undefined) p.highestFeuerwerkTurnScore = recordFromSnapshot(previousHighestFeuerwerkTurnScore);
  if (previousHighestX2TurnScore !== undefined) p.highestX2TurnScore = recordFromSnapshot(previousHighestX2TurnScore);
  p.score -= (previousScore ?? 0);

  // A chained turn consumed several cards: put them all back so the replayed
  // turn draws the exact same sequence — the first chain card is re-dealt,
  // the rest go back on top of the deck ahead of the next player's card.
  const chainCards = previousTurnSummary?.cards.map(c => c.card);
  const hasChain = !!chainCards && chainCards.length > 0;
  // ...and the turn being discarded gives back everything IT drew, not just
  // the card in play (see inProgressChainCards).
  const liveCards = inProgressChainCards(currentCard, liveTurnState);

  return {
    players: newPlayers,
    nextIndex: prevIndex,
    nextRound: newRound,
    isRoundEndUndo,
    newDeck: hasChain
      ? [...chainCards.slice(1), ...liveCards, ...cards]
      : [...liveCards, ...cards],
    drawnCard: hasChain ? chainCards[0] : definitePreviousCard,
  };
};
