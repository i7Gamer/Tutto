import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real-timer animation path: isTestEnv normally short-circuits every
// tumble timer to zero, which makes the mid-animation window unobservable —
// this file mocks it false so roll() schedules the real per-die settles.
vi.mock('../utils/env', () => ({ isTestEnv: () => false }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));
vi.mock('../utils/soundEffects', () => ({
  playBuzzer: vi.fn(), playSuccess: vi.fn(), playTone: vi.fn(),
  vibrateBust: vi.fn(), vibrateSuccess: vi.fn(),
}));
// Every die shows a 1 — always scoring, never a bust.
vi.mock('../utils/diceLogic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/diceLogic')>()),
  rollDie: () => 1,
}));

import DiceGame from './DiceGame';
import { DIE_TUMBLE_MS, LIVE_SNAPSHOT_DEBOUNCE_MS } from '../utils/uiTimings';

describe('mid-roll live snapshots (spectator tumble animation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('sends a snapshot carrying rollingDiceIds while the dice are still tumbling', () => {
    // Spectators render the tumble purely from snapshots' rollingDiceIds
    // (GameControls). Snapshots used to wait for isRolling to clear — by
    // which time every per-die timer had emptied the set, so live data never
    // carried a single rolling id and the whole animation path was dead.
    const onStateChange = vi.fn();
    render(<DiceGame currentCard="300" onComplete={vi.fn()} onStateChange={onStateChange} />);

    // Past the snapshot debounce, before the first die settles.
    expect(LIVE_SNAPSHOT_DEBOUNCE_MS).toBeLessThan(DIE_TUMBLE_MS);
    act(() => { vi.advanceTimersByTime(DIE_TUMBLE_MS - 50); });

    const rolling = onStateChange.mock.calls
      .map(([snap]) => snap)
      .filter(snap => (snap?.rollingDiceIds?.length ?? 0) > 0);
    expect(rolling.length).toBeGreaterThan(0);
    expect(rolling[0].rollingDiceIds).toHaveLength(6);
  });

  it('still sends the settled snapshot once the roll finalizes', () => {
    const onStateChange = vi.fn();
    render(<DiceGame currentCard="300" onComplete={vi.fn()} onStateChange={onStateChange} />);

    // Through the whole animation and the settle buffer; the effect that
    // schedules the post-finalize debounce flushes at this act boundary…
    act(() => { vi.advanceTimersByTime(2000); });
    // …and the debounce itself needs its own advancement window.
    act(() => { vi.advanceTimersByTime(LIVE_SNAPSHOT_DEBOUNCE_MS + 50); });

    const last = onStateChange.mock.calls.at(-1)?.[0];
    expect(last).toBeTruthy();
    expect(last.rollingDiceIds ?? []).toHaveLength(0);
    expect(last.currentRoll).toHaveLength(6);
  });
});
