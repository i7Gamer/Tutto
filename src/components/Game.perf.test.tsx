/**
 * Pins the fix for "dice animations get janky the longer the game runs"
 * (see the render-count/timing investigation this test formalizes): Game.tsx
 * re-renders on every liveTurnState tick during a roll (DiceGame's
 * onStateChange -> pushLiveTurnState -> setLiveTurnState, ~every
 * LIVE_SNAPSHOT_DEBOUNCE_MS), and — before HistoryLog, Leaderboard,
 * Scoreboard and CardDisplay were memoized — a plain (non-memoized)
 * function component re-runs its whole body whenever its PARENT re-renders,
 * regardless of whether its own props changed. HistoryLog holds up to
 * MAX_HISTORY_LOG_SIZE (50) framer-motion entries under AnimatePresence, so
 * that cost grows with how long the game has run — matching the report.
 *
 * GameControls is the one exception: it mirrors the ACTIVE player's live
 * dice for spectators (and shows the rolling/kept dice), so it MUST keep
 * re-rendering on every update — it reads liveTurnState directly off the
 * store itself (see GameControls.tsx's own useGameStore selector), so it
 * re-renders independently of whatever Game.tsx does or doesn't memoize.
 */
import { memo, type ComponentType } from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Game from './Game';
import { useGameStore, _resetTimersForTests } from '../store/useGameStore';
import { makePlayer, makeDiceSnapshot, makeHistoryEntry } from '../testing/factories';
import { MAX_HISTORY_LOG_SIZE, type HistoryEntry } from '../types';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  vibrateYourTurn: vi.fn(),
  vibrateTurnUrgent: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// vi.mock factories are hoisted above every other statement in this file
// (including plain `const`s declared above them, textually), so anything a
// factory needs to close over has to come from vi.hoisted, whose callback
// runs first. `memo` (the top-of-file `import`) is safe to reference in
// here regardless: it's a real ES import, resolved by the module loader
// before this file's own body runs, unlike a plain local `const`.
const { renderCounts, countRenders } = vi.hoisted(() => {
  const counts = {
    HistoryLog: 0,
    Leaderboard: 0,
    Scoreboard: 0,
    CardDisplay: 0,
    GameControls: 0,
  };
  // The stable identity React.memo stamps onto its wrapper object — the
  // same symbol the `react-is` package checks for (not taken as a
  // dependency here: this needs one boolean, not a whole package).
  const REACT_MEMO_TYPE = Symbol.for('react.memo');
  const isMemoComponent = (Component: unknown): boolean =>
    typeof Component === 'object' && Component !== null
    && (Component as { $$typeof?: symbol }).$$typeof === REACT_MEMO_TYPE;

  /**
   * Wraps a mocked module's default export with a render counter, WITHOUT
   * changing whether the export itself bails out of a re-render when its
   * own props haven't changed — which is exactly what this test pins.
   *
   * A naive wrapper (`(props) => { count++; return <Real {...props}/> }`)
   * would always run on every parent re-render regardless of Real's own
   * memoization, because the wrapper itself is what Game directly
   * instantiates and it isn't memoized. So: if Real is already memo(...),
   * the counting shell is ALSO wrapped in memo() with the same default
   * shallow-prop comparator — it then bails under exactly the conditions
   * Real itself would, and the counter only increments on a genuine
   * re-render. If Real is a plain function component, the shell stays
   * unmemoized and counts every call, matching a plain component's real
   * behavior (it re-renders whenever its parent does, regardless of props).
   */
  const countRenders = <P extends object>(RealComponent: ComponentType<P>, onRender: () => void): ComponentType<P> => {
    const Counted = (props: P) => { onRender(); return <RealComponent {...props} />; };
    return (isMemoComponent(RealComponent) ? memo(Counted) : Counted) as ComponentType<P>;
  };

  return { renderCounts: counts, countRenders };
});

vi.mock('./game/HistoryLog', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./game/HistoryLog')>();
  return { ...mod, default: countRenders(mod.default, () => { renderCounts.HistoryLog += 1; }) };
});
vi.mock('./game/Leaderboard', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./game/Leaderboard')>();
  return { ...mod, default: countRenders(mod.default, () => { renderCounts.Leaderboard += 1; }) };
});
vi.mock('./game/Scoreboard', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./game/Scoreboard')>();
  return { ...mod, default: countRenders(mod.default, () => { renderCounts.Scoreboard += 1; }) };
});
vi.mock('./game/CardDisplay', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./game/CardDisplay')>();
  return { ...mod, default: countRenders(mod.default, () => { renderCounts.CardDisplay += 1; }) };
});
vi.mock('./game/GameControls', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./game/GameControls')>();
  return { ...mod, default: countRenders(mod.default, () => { renderCounts.GameControls += 1; }) };
});

const FOUR_PLAYERS = ['Alice', 'Bob', 'Carol', 'Dave'];
const LIVE_UPDATE_COUNT = 20;

const buildHistoryLog = (size: number): HistoryEntry[] =>
  Array.from({ length: size }, (_, i) => makeHistoryEntry({
    id: `h${i}`,
    round: Math.floor(i / FOUR_PLAYERS.length) + 1,
    playerName: FOUR_PLAYERS[i % FOUR_PLAYERS.length],
    card: '300',
    type: 'success',
    score: 100 + i,
  }));

// A snapshot that differs a bit on every call — mirrors DiceGame's
// onStateChange, which fires on every die settle/selection with a new
// rollingDiceIds/keptDice each time (see DiceGame.tsx's live-snapshot
// effect, around its LIVE_SNAPSHOT_DEBOUNCE_MS timer).
const buildLiveSnapshot = (i: number) => makeDiceSnapshot({
  turnScore: i * 50,
  currentRoll: Array.from({ length: 6 }, (_, d) => ({
    id: `die-${d}`,
    val: ((i + d) % 6) + 1,
    selected: d < (i % 6),
  })),
  rollingDiceIds: i % 2 === 0 ? [`die-${i % 6}`] : [],
  tuttosThisTurn: 0,
});

describe('Game live-update re-render scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderCounts.HistoryLog = 0;
    renderCounts.Leaderboard = 0;
    renderCounts.Scoreboard = 0;
    renderCounts.CardDisplay = 0;
    renderCounts.GameControls = 0;

    useGameStore.getState().reset();
    _resetTimersForTests();
    localStorage.clear();
    sessionStorage.clear();
    useGameStore.setState({
      isOnline: true,
      hostId: 'socket1',
      myName: 'Alice',
      currentPlayerIndex: 0,
      currentCard: 'x2',
      diceMode: 'digital',
      ruleset: 'modernized',
      winningScore: 6000,
      players: FOUR_PLAYERS.map((name, i) => makePlayer({ name, socketId: `socket${i + 1}`, position: i + 1, score: i * 500 })),
      historyLog: buildHistoryLog(MAX_HISTORY_LOG_SIZE),
    });
  });

  afterEach(() => {
    act(() => { vi.runOnlyPendingTimers(); });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it(`re-renders HistoryLog/Leaderboard/Scoreboard/CardDisplay 0 times and GameControls ${LIVE_UPDATE_COUNT} times over ${LIVE_UPDATE_COUNT} liveTurnState updates`, () => {
    render(<Game />);
    const afterMount = { ...renderCounts };

    for (let i = 0; i < LIVE_UPDATE_COUNT; i++) {
      act(() => {
        useGameStore.getState().setLiveTurnState(buildLiveSnapshot(i));
      });
    }

    expect(renderCounts.HistoryLog - afterMount.HistoryLog).toBe(0);
    expect(renderCounts.Leaderboard - afterMount.Leaderboard).toBe(0);
    expect(renderCounts.Scoreboard - afterMount.Scoreboard).toBe(0);
    expect(renderCounts.CardDisplay - afterMount.CardDisplay).toBe(0);
    // The one component that MUST keep re-rendering: it draws the
    // spectator's live view of the active player's dice, and reads
    // liveTurnState off the store directly (not as a prop from Game).
    expect(renderCounts.GameControls - afterMount.GameControls).toBe(LIVE_UPDATE_COUNT);
  });
});
