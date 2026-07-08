import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { parseSavedDiceState } from '../utils/diceTurnState';
import DiceGame from './DiceGame';
import { playTone } from '../utils/soundEffects';

vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(),
  playSuccess: vi.fn(),
  playTone: vi.fn(),
  vibrateBust: vi.fn(),
  vibrateSuccess: vi.fn(),
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

// Deterministic dice: rollDie() drains this queue and falls back to the real
// implementation when empty (so tests that don't care keep working).
const { rollQueue } = vi.hoisted(() => ({ rollQueue: [] as number[] }));

vi.mock('../utils/diceLogic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/diceLogic')>();
  return {
    ...actual,
    rollDie: () => (rollQueue.length > 0 ? rollQueue.shift()! : actual.rollDie()),
  };
});

// Each roll consumes 2N rollDie() calls: N for the real values and N for the
// initial display values (which the test-env path immediately overwrites), so
// the values are pushed twice.
const queueRoll = (vals: number[]) => { rollQueue.push(...vals, ...vals); };

// Real isTestEnv() collapses all of DiceGame's roll/bust animation timers to 0
// (they fire synchronously), which is convenient elsewhere but means there'd
// be nothing to verify cleanup against for the unmount test below. Default to
// the real (true) behavior for every other test; only the cleanup test flips
// this to false to exercise the actual setTimeout-scheduling code paths.
const isTestEnvMock = vi.fn(() => true);
vi.mock('../utils/env', () => ({ isTestEnv: () => isTestEnvMock() }));

describe('DiceGame State Restoration Logic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('parses and restores turnScore from localStorage', () => {
    const savedState = { turnScore: 250, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.turnScore).toBe(250);
  });

  it('preserves kniffelProgress array structure when restoring', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [1, 2, 3],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(Array.isArray(restored?.kniffelProgress)).toBe(true);
    expect(restored?.kniffelProgress).toEqual([1, 2, 3]);
  });

  it('correctly converts undefined busted to false', () => {
    const savedState = {
      turnScore: 100,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(false);
  });

  it('preserves busted=true when present', () => {
    const savedState = {
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 0,
      busted: true
    };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(savedState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.busted).toBe(true);
  });

  it('returns null when localStorage has no saved state', () => {
    localStorage.removeItem('tutto_dice_turn_state');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('returns null when saved state is invalid JSON', () => {
    localStorage.setItem('tutto_dice_turn_state', 'not valid json {]');

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored).toBeNull();
  });

  it('provides defaults for missing optional fields', () => {
    const minimalState = { turnScore: 50 };
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(minimalState));

    const restored = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));

    expect(restored?.keptDice).toEqual([]);
    expect(restored?.kniffelProgress).toEqual([]);
    expect(restored?.tuttosThisTurn).toBe(0);
  });
});

describe('DiceGame restored-state bust rendering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows the same "Bust!" summary for a restored Kleeblatt bust as a live one', () => {
    // Simulates a page reload/reconnect mid-Kleeblatt-turn right after busting.
    // Kleeblatt is all-or-nothing (needs 2 successful tuttos), so a bust always
    // forfeits the turn regardless of tuttosThisTurn banked so far — the restored
    // path (DiceGame.tsx init effect) and the live bust path both produce
    // { won: false, score: 0 }, so the rendered summary must match exactly.
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify({
      turnScore: 0,
      keptDice: [],
      currentRoll: [],
      kniffelProgress: [],
      tuttosThisTurn: 1,
      busted: true,
    }));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    expect(screen.queryByText('dice.success')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.tutto')).not.toBeInTheDocument();
    expect(screen.queryByText('dice.points_gained')).not.toBeInTheDocument();
  });
});

describe('DiceGame stale turn restoration (turnKey)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // A player's turn ended (e.g. the server's turn timer advanced past them while
  // disconnected) without their own client ever running the code that clears this
  // cache entry — so it survives, stamped for a turn that is no longer current.
  const staleSnapshot = {
    turnScore: 0,
    keptDice: [],
    currentRoll: [],
    kniffelProgress: [],
    tuttosThisTurn: 1,
    busted: true,
    turnKey: 'ROOM1:2:0:Kleeblatt',
  };

  it('restores the snapshot when turnKey matches the current turn', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));

    render(<DiceGame currentCard="Kleeblatt" turnKey="ROOM1:2:0:Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
  });

  it('discards a snapshot stamped for a different turn instead of resuming it', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));
    queueRoll([1, 2, 3, 4, 6, 6]); // includes a 1 so the fresh auto-roll can't bust

    // Same player and card, but the round has advanced — a later turn, not a
    // resumable one.
    render(<DiceGame currentCard="Kleeblatt" turnKey="ROOM1:3:0:Kleeblatt" onComplete={vi.fn()} />);

    // A fresh turn auto-rolls immediately, not the stale bust summary.
    expect(screen.getAllByLabelText(/Die showing/).length).toBe(6);
    expect(screen.queryByText('dice.bust')).not.toBeInTheDocument();
    // Cleared, not just ignored, so it can't resurface on a later mount either.
    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
  });

  it('restores unconditionally when the caller does not pass turnKey (backward compatible)', () => {
    localStorage.setItem('tutto_dice_turn_state', JSON.stringify(staleSnapshot));

    render(<DiceGame currentCard="Kleeblatt" onComplete={vi.fn()} />);

    expect(screen.getByText('dice.bust')).toBeInTheDocument();
  });
});

describe('DiceGame interactive turn logic', () => {
  beforeEach(() => {
    localStorage.clear();
    rollQueue.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const selectAllValid = () => fireEvent.click(screen.getByText('dice.select_all_valid'));
  const clickDie = (val: number) => {
    const dice = screen.getAllByLabelText(`Die showing ${val}, not selected`);
    fireEvent.click(dice[0]);
  };

  it('scores the selected dice and completes the turn on Stop & Score', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 5, 2, 2, 3, 4]);
    render(<DiceGame currentCard="200" onComplete={onComplete} />);

    clickDie(1);
    clickDie(5);
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    // 100 (single 1) + 50 (single 5); auto-continue fires onComplete in test env
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(150, true));
  });

  it('renders kept dice as pip faces, not raw digits, matching the current-roll dice style', () => {
    queueRoll([1, 5, 2, 2, 3, 4]); // first (auto) roll
    queueRoll([5, 2, 3, 4, 6]); // reroll of the 5 dice not kept — includes a 5 so it isn't a bust
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    clickDie(1);
    fireEvent.click(screen.getByText('dice.roll_again'));

    const keptDiceBox = screen.getByText('dice.kept_dice').nextElementSibling as HTMLElement;
    // A pip face is a 3x3 grid of dot divs (see DiePips), not the bare "1".
    expect(keptDiceBox.querySelector('.grid-cols-3')).not.toBeNull();
    expect(keptDiceBox).not.toHaveTextContent('1');
  });

  it('marks a non-scoring selection invalid and disables both action buttons', () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    clickDie(2); // a lone 2 can never score

    expect(screen.getByText('dice.invalid_selection')).toBeInTheDocument();
    expect(screen.getByText('dice.roll_again').closest('button')).toBeDisabled();
    // Stop & Score stays mounted (disabled), not removed — removing it used
    // to resize the sibling Roll Again button, producing a visible layout jump.
    expect(screen.getByText('dice.stop_and_score').closest('button')).toBeDisabled();
  });

  it('keeps Stop & Score mounted in place when selection validity toggles, instead of unmounting it', () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    clickDie(1); // a lone 1 scores: valid
    const stopButtonWhenValid = screen.getByText('dice.stop_and_score').closest('button');
    expect(stopButtonWhenValid).not.toBeDisabled();

    clickDie(2); // 1+2 together don't score: invalid
    const stopButtonWhenInvalid = screen.getByText('dice.stop_and_score').closest('button');

    // Same DOM node across the toggle proves it was disabled in place rather
    // than unmounted and re-mounted (which would resize the button row).
    expect(stopButtonWhenInvalid).toBe(stopButtonWhenValid);
    expect(stopButtonWhenInvalid).toBeDisabled();
  });

  it('keeps the invalid-selection indicator mounted and only toggles its visibility', () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    clickDie(1); // valid: indicator hidden
    const indicatorWhenValid = screen.getByText('dice.invalid_selection');
    expect(indicatorWhenValid.className).toMatch(/invisible/);

    clickDie(2); // invalid: indicator visible
    const indicatorWhenInvalid = screen.getByText('dice.invalid_selection');
    expect(indicatorWhenInvalid.className).not.toMatch(/invisible/);

    // Same node — no pop-in remount.
    expect(indicatorWhenInvalid).toBe(indicatorWhenValid);
  });

  it('does not remount the score display when only selection validity changes', () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    clickDie(1); // valid
    const scoreNodeWhenValid = screen.getByTestId('dice-current-score');

    clickDie(2); // invalid
    const scoreNodeWhenInvalid = screen.getByTestId('dice-current-score');

    expect(scoreNodeWhenInvalid).toBe(scoreNodeWhenValid);
  });

  it('busting a regular card ends the turn with 0 points', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]); // no 1/5 and no triplet → bust
    render(<DiceGame currentCard="300" onComplete={onComplete} />);


    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('a Tutto on a bonus card ends the turn immediately with the bonus applied', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="400" onComplete={onComplete} />);

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    // 1000 (triple 1s) + 500 (triple 5s) + 400 bonus
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1900, true));
  });

  it('a Tutto on x2 doubles the turn score', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="x2" onComplete={onComplete} />);

    selectAllValid();
    fireEvent.click(screen.getByText('dice.stop_and_score'));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(3000, true));
  });

  it('Feuerwerk keeps rolling after a Tutto and banks all points on the eventual bust', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]); // first roll: full Tutto worth 1500
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} />);

    selectAllValid();

    // Feuerwerk never offers Stop — only Roll Again.
    expect(screen.queryByText('dice.stop_and_score')).not.toBeInTheDocument();

    queueRoll([2, 2, 3, 3, 4, 6]); // forced re-roll busts
    fireEvent.click(screen.getByText('dice.roll_again'));

    expect(screen.getByText('dice.success')).toBeInTheDocument();
    // The bust still banks everything rolled before it — a Feuerwerk "win".
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1500, true));
  });

  it('Feuerwerk busting on the first roll scores 0 and counts as a loss', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]);
    render(<DiceGame currentCard="Feuerwerk" onComplete={onComplete} />);


    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('Kleeblatt needs two Tuttos: the first re-rolls automatically, the second wins', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 1, 1, 5, 5, 5]);
    // The first Tutto immediately triggers the second 6-dice roll — queue it up front.
    queueRoll([1, 1, 1, 5, 5, 5]);
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} />);

    selectAllValid();
    fireEvent.click(screen.getByText('dice.roll_2nd_tutto'));

    // Second roll is live now; one Tutto banked.
    expect(screen.getByText('dice.tuttos_count')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(3000, true));
  });

  it('Kleeblatt busting forfeits the card as a loss', async () => {
    const onComplete = vi.fn();
    queueRoll([2, 2, 3, 3, 4, 6]);
    render(<DiceGame currentCard="Kleeblatt" onComplete={onComplete} />);


    expect(screen.getByText('dice.bust')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, false));
  });

  it('Kniffel builds the run across rolls and completes with score 0 (engine awards the 2000)', async () => {
    const onComplete = vi.fn();
    queueRoll([1, 2, 3, 2, 4, 6]);
    render(<DiceGame currentCard="Kniffel" onComplete={onComplete} />);

    selectAllValid(); // picks the 1-2-3-4 run
    queueRoll([5, 6]); // two dice remain; the run needs 5 then 6
    fireEvent.click(screen.getByText('dice.roll_again'));

    // roll_again above already consumed the queued roll; select the completion
    selectAllValid();
    fireEvent.click(screen.getByText('dice.finish_card'));

    expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    // Kniffel itself scores 0 — calculateNextTurn turns the success into 2000.
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(0, true));
  });

  it('does not roll automatically while the panel is still appearing (panelReady=false)', () => {
    render(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={false} />);

    expect(screen.queryAllByLabelText(/Die showing/).length).toBe(0);
    expect(playTone).not.toHaveBeenCalled();
  });

  it('auto-rolls as soon as panelReady flips to true', () => {
    queueRoll([1, 5, 2, 2, 3, 4]);
    const { rerender } = render(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={false} />);

    expect(screen.queryAllByLabelText(/Die showing/).length).toBe(0);

    rerender(<DiceGame currentCard="200" onComplete={vi.fn()} panelReady={true} />);

    expect(screen.getAllByLabelText(/Die showing/).length).toBe(6);

    // This describe block's beforeEach clears mocks before each test, but not
    // after the last one — leaving this roll's playTone calls to bleed into
    // the next describe block's own playTone-count assertions.
    vi.mocked(playTone).mockClear();
  });
});

describe('DiceGame pending timer cleanup on unmount', () => {
  beforeEach(() => {
    localStorage.clear();
    // Disable the test-env fast path so roll() actually schedules its
    // animation/finalize setTimeouts instead of running everything synchronously
    // — otherwise there would be nothing queued to verify cleanup against.
    isTestEnvMock.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    isTestEnvMock.mockReturnValue(true);
    localStorage.clear();
  });

  it('clears every pending timer on unmount so no callbacks fire afterward', () => {
    // roll() calls playTone once synchronously (the initial "shake" tone) and
    // then once per die via the staggered tumble timers that live in
    // pendingTimers — that second batch is what unmount must actually cancel.
    // A prop-callback spy (onComplete/onStateChange) doesn't work here: they're
    // wired to *other*, independently-cleaned-up effects and would pass even
    // with pendingTimers cleanup deleted entirely (verified by temporarily
    // removing it — the callback-spy version still passed, a false negative).
    const { unmount } = render(
      <DiceGame currentCard="200" onComplete={vi.fn()} />
    );

    expect(playTone).toHaveBeenCalledTimes(1); // the synchronous "shake" tone only

    // Unmount immediately — before any of the 6 staggered per-die timers fire.
    unmount();
    vi.mocked(playTone).mockClear();

    // If pendingTimers cleanup didn't run, each die's tumble timer would call
    // playTone here.
    act(() => { vi.runAllTimers(); });

    expect(playTone).not.toHaveBeenCalled();
  });
});

describe('DiceGame roll-again mid-animation button stability', () => {
  beforeEach(() => {
    localStorage.clear();
    rollQueue.length = 0;
    // Disable the test-env fast path so isRolling actually stays true for a
    // stretch after Roll Again, instead of the roll resolving synchronously.
    isTestEnvMock.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    isTestEnvMock.mockReturnValue(true);
    localStorage.clear();
  });

  it('disables Roll Again and Stop & Score in place mid-reroll, instead of unmounting Stop & Score', () => {
    queueRoll([1, 2, 3, 4, 6, 6]);
    render(<DiceGame currentCard="200" onComplete={vi.fn()} />);

    // advanceTimersByTime, not runAllTimers: the tumbling-display effect runs
    // a recurring setInterval while dice are rolling (isTestEnv() is false in
    // this suite), which runAllTimers would spin on forever.
    act(() => { vi.advanceTimersByTime(2000); }); // let the first roll's animation settle

    fireEvent.click(screen.getAllByLabelText('Die showing 1, not selected')[0]); // a lone 1 scores: valid

    const rollAgainBefore = screen.getByText('dice.roll_again').closest('button');
    const stopBefore = screen.getByText('dice.stop_and_score').closest('button');
    expect(rollAgainBefore).not.toBeDisabled();
    expect(stopBefore).not.toBeDisabled();

    queueRoll([2, 3, 4, 6, 1]); // reroll of the 5 dice not kept (includes a 1 so it isn't a bust)
    fireEvent.click(screen.getByText('dice.roll_again')); // starts the reroll: isRolling(true)

    // Mid-animation, before the reroll's timers have run: both buttons must
    // still be the same mounted nodes, merely disabled — previously canStop
    // unmounted Stop & Score here, snapping Roll Again to full width.
    const rollAgainDuring = screen.getByText('dice.roll_again').closest('button');
    const stopDuring = screen.getByText('dice.stop_and_score').closest('button');
    expect(rollAgainDuring).toBe(rollAgainBefore);
    expect(stopDuring).toBe(stopBefore);
    expect(rollAgainDuring).toBeDisabled();
    expect(stopDuring).toBeDisabled();

    act(() => { vi.advanceTimersByTime(2000); }); // finish the reroll animation

    // Still the same nodes once isRolling clears — no remount either way.
    expect(screen.getByText('dice.roll_again').closest('button')).toBe(rollAgainBefore);
    expect(screen.getByText('dice.stop_and_score').closest('button')).toBe(stopBefore);
  });
});
