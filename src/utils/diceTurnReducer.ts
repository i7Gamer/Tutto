import type { CardType, DiceSnapshot, Die, Ruleset } from '../types';
import { withForcedFeuerwerkSelection } from './diceTurnControls';
import type { RestoredSummary, RestoredTurn } from './diceTurnRestore';

/**
 * The dice turn's semantic state machine, carved out of DiceGame.tsx.
 *
 * These are the fields that must move TOGETHER when the turn changes shape —
 * the ones a live snapshot carries to spectators and a reload restores from.
 * As eleven separate useStates they were committed through repeated blocks
 * of five to eight setter calls, and a transition that forgot one left the
 * machine torn (a banked turn whose snapshot still offered dice to reroll was
 * exactly that bug). Here every transition is one action, so a field cannot
 * be forgotten without the transition's unit test seeing it.
 *
 * Presentation state stays in the component on purpose: displayRoll,
 * rollingDiceIndices and isRolling exist for the tumble animation (per-die
 * settle timers write them on their own clock), and revealedCard is the
 * drawn-card modal. None of them decide anything about the turn.
 *
 * Side effects stay in the component too — sounds, confetti, timer
 * choreography, the classic chain's mutable ref, and the store round-trips.
 * The actions carry values the handlers computed (scores via diceLogic.ts);
 * this module owns which fields those values land in.
 */
export interface DiceTurnState {
  keptDice: Die[];
  currentRoll: Die[];
  turnScore: number;
  kniffelProgress: number[];
  hasRolled: boolean;
  bustState: boolean;
  /** The turn is decided and banked — rides the snapshot so a reload restores the decision. */
  stopped: boolean;
  showSummary: boolean;
  summaryData: RestoredSummary;
  tuttosThisTurn: number;
  /** Render-safe mirror of the classic chain's length (the chain itself lives in a ref). */
  chainCardCount: number;
}

export type DiceTurnAction =
  /** A fresh set of dice hits the table (roll() already built them). */
  | { type: 'ROLL_STARTED'; rolls: Die[] }
  /** finalizeRoll judged the settled roll a bust. */
  | { type: 'ROLL_BUSTED' }
  /** Classic Feuerwerk: the official rule keeps every scoring die, uneditable. */
  | { type: 'FEUERWERK_SELECTION_FORCED'; ruleset: Ruleset }
  | { type: 'DIE_TOGGLED'; id: string }
  /** Select exactly these table indices (the select-all-valid shortcut). */
  | { type: 'SELECTION_SET'; indices: ReadonlySet<number> }
  /** Bank the selection into the running fields and keep rolling — roll() replaces the table itself. */
  | { type: 'ROLL_ON_COMMITTED'; turnScore: number; keptDice: Die[]; kniffelProgress: number[] }
  /** Kleeblatt's first tutto: the tray clears and the second attempt begins. */
  | { type: 'KLEEBLATT_FIRST_TUTTO'; turnScore: number; kniffelProgress: number[] }
  /** Commit a decided table (tutto or stop) — the roll leaves the board; banking is a separate decision. */
  | { type: 'TABLE_COMMITTED'; turnScore: number; keptDice: Die[]; kniffelProgress: number[] }
  /** The decision is to bank: mark stopped and open the summary on it. */
  | { type: 'TURN_BANKED'; summary: RestoredSummary }
  /** Open the summary WITHOUT the stopped marker (bust verdicts, a drawn Stop's forfeit). */
  | { type: 'SUMMARY_SHOWN'; summary: RestoredSummary }
  /** Classic chain: the next card is drawn, the table resets onto the chain total. */
  | { type: 'CHAIN_DRAWN'; card: CardType; base: number }
  /** The draw's push was discarded by the store — take the entry back and bank what was committed. */
  | { type: 'DRAW_ABANDONED'; summary: RestoredSummary };

const FRESH_SUMMARY: RestoredSummary = { won: false, score: 0, isTutto: false };

/**
 * The state a DiceGame mount starts from. All judgment about WHAT to resume
 * (mid-tumble busts, forced keeps, banked decisions) already happened in
 * diceTurnRestore.ts — this only lays its verdict out as machine fields, the
 * same mapping the component's eleven useState initializers used to spell
 * out one by one.
 */
export const initialDiceTurnState = ({ restored, restore }: {
  restored: DiceSnapshot | null;
  restore: RestoredTurn;
}): DiceTurnState => ({
  keptDice: restored?.keptDice ?? [],
  currentRoll: restore.currentRoll,
  turnScore: restored?.turnScore ?? 0,
  kniffelProgress: restored?.kniffelProgress ?? [],
  hasRolled: restore.hasRolled,
  bustState: restore.busted,
  stopped: restore.bankedDecision,
  // A decided restore (bust, banked tutto, forfeit) opens on its summary.
  showSummary: restore.summary !== null,
  summaryData: restore.summary ?? FRESH_SUMMARY,
  tuttosThisTurn: restored?.tuttosThisTurn ?? 0,
  chainCardCount: restore.initialChain.cards.length,
});

/** Compile-time exhaustiveness: a new action that no case handles refuses to build. */
const assertHandled = (action: never): never => {
  throw new Error(`diceTurnReducer: unhandled action ${JSON.stringify(action)}`);
};

export const diceTurnReducer = (state: DiceTurnState, action: DiceTurnAction): DiceTurnState => {
  switch (action.type) {
    case 'ROLL_STARTED':
      return { ...state, currentRoll: action.rolls, bustState: false, hasRolled: true };

    case 'ROLL_BUSTED':
      return { ...state, bustState: true };

    case 'FEUERWERK_SELECTION_FORCED':
      return { ...state, currentRoll: withForcedFeuerwerkSelection(state.currentRoll, action.ruleset) };

    case 'DIE_TOGGLED':
      return {
        ...state,
        currentRoll: state.currentRoll.map(d => d.id === action.id ? { ...d, selected: !d.selected } : d),
      };

    case 'SELECTION_SET':
      return {
        ...state,
        currentRoll: state.currentRoll.map((d, i) => ({ ...d, selected: action.indices.has(i) })),
      };

    case 'ROLL_ON_COMMITTED':
      return {
        ...state,
        turnScore: action.turnScore,
        keptDice: action.keptDice,
        kniffelProgress: action.kniffelProgress,
      };

    case 'KLEEBLATT_FIRST_TUTTO':
      return {
        ...state,
        tuttosThisTurn: 1,
        keptDice: [],
        turnScore: action.turnScore,
        kniffelProgress: action.kniffelProgress,
      };

    case 'TABLE_COMMITTED':
      return {
        ...state,
        turnScore: action.turnScore,
        keptDice: action.keptDice,
        kniffelProgress: action.kniffelProgress,
        currentRoll: [],
      };

    case 'TURN_BANKED':
      return { ...state, stopped: true, summaryData: action.summary, showSummary: true };

    case 'SUMMARY_SHOWN':
      return { ...state, summaryData: action.summary, showSummary: true };

    case 'CHAIN_DRAWN':
      return {
        ...state,
        chainCardCount: state.chainCardCount + 1,
        showSummary: false,
        turnScore: action.base,
        keptDice: [],
        currentRoll: [],
        kniffelProgress: [],
        bustState: false,
        // Kleeblatt needs two tuttos from scratch, whenever it turns up.
        tuttosThisTurn: action.card === 'Kleeblatt' ? 0 : state.tuttosThisTurn,
        // A drawn Stop keeps whatever the summary held: its forfeit summary is
        // written on dismissal of the reveal, not here.
        summaryData: action.card === 'Stop' ? state.summaryData : FRESH_SUMMARY,
      };

    case 'DRAW_ABANDONED':
      return {
        ...state,
        chainCardCount: state.chainCardCount - 1,
        stopped: true,
        summaryData: action.summary,
        showSummary: true,
      };

    default:
      return assertHandled(action);
  }
};
