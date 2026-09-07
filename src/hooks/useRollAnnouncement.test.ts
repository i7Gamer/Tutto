import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRollAnnouncement, type UseRollAnnouncementOptions } from './useRollAnnouncement';

// A stable spy (not the shared setup mock's bare-key `t`) so the suffix
// clauses can be asserted on: the hook translates dice.announce.completesCard
// and dice.announce.turnSoFar itself before folding them into the single
// announce() call (the codebase's established pattern for a composed
// message — see HistoryLog.tsx's `deducted` fragment folded into
// history.chainSuccessDeducted). i18n.language is pinned to 'en' so
// formatList's output is deterministic regardless of this machine's locale.
const { translate } = vi.hoisted(() => ({
  translate: vi.fn<(key: string, opts?: Record<string, unknown>) => string>(key => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('useRollAnnouncement', () => {
  // Typed as the Mock (not just the plain callback shape) so tests below can
  // read announce.mock.calls directly.
  type AnnounceMock = ReturnType<typeof vi.fn<(key: string, values: Record<string, unknown>) => void>>;
  type TestOptions = UseRollAnnouncementOptions & { announce: AnnounceMock };

  const base = (over: Partial<TestOptions> = {}): TestOptions => ({
    hasRolled: true,
    isRolling: true,
    bustState: false,
    rollVals: [1, 1, 5, 2, 3, 4],
    currentCard: '200',
    kniffelProgress: [],
    ruleset: 'modernized',
    keptCount: 0,
    turnScore: 0,
    announce: vi.fn<(key: string, values: Record<string, unknown>) => void>(),
    ...over,
  });

  beforeEach(() => {
    translate.mockClear();
  });

  it('announces once when a roll settles, with the scoring key and interpolation values', () => {
    const options = base({ isRolling: true });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    expect(options.announce).not.toHaveBeenCalled();

    rerender({ ...options, isRolling: false });

    expect(options.announce).toHaveBeenCalledTimes(1);
    expect(options.announce).toHaveBeenCalledWith('dice.announce.rollLanded', {
      values: '1, 1, 5, 2, 3, and 4',
      count: 3,
      score: 250,
      completesSuffix: '',
      turnSoFarSuffix: '',
    });
  });

  it('does not announce while the dice are still tumbling', () => {
    const options = base({ isRolling: true });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: true });
    expect(options.announce).not.toHaveBeenCalled();
  });

  // MUTATION CHECK (see feature plan): deleting the `!bustState` guard in
  // useRollAnnouncement.ts must make this test fail — proof the guard is
  // load-bearing and not just decorative.
  it('does not announce a settle that busted', () => {
    const options = base({ isRolling: true, bustState: false });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false, bustState: true });
    expect(options.announce).not.toHaveBeenCalled();
  });

  it('does not announce on mount for a resumed turn that already has hasRolled true', () => {
    // DiceGame never restores isRolling to true on a resume (only hasRolled
    // is seeded), so there is no false-to-true edge to fire on at mount.
    const options = base({ hasRolled: true, isRolling: false });
    renderHook(() => useRollAnnouncement(options));
    expect(options.announce).not.toHaveBeenCalled();
  });

  it('announces again on a later settle, not just the first one', () => {
    const options = base({ isRolling: true });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });
    rerender({ ...options, isRolling: true });
    rerender({ ...options, isRolling: false });
    expect(options.announce).toHaveBeenCalledTimes(2);
  });

  it('uses the fixed-award key with a null score for Kniffel', () => {
    const options = base({
      isRolling: true,
      currentCard: 'Kniffel',
      rollVals: [1, 2, 3, 4, 5, 6],
    });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });

    expect(options.announce).toHaveBeenCalledWith('dice.announce.rollLandedFixed', {
      values: '1, 2, 3, 4, 5, and 6',
      count: 6,
      score: null,
      completesSuffix: ' dice.announce.completesCard',
      turnSoFarSuffix: '',
    });
  });

  it('appends the completesCard suffix when the roll completes a tutto', () => {
    const options = base({
      isRolling: true,
      rollVals: [2, 2, 2, 3, 4, 6],
      keptCount: 3,
    });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });

    const [, values] = options.announce.mock.calls[0];
    expect(values.completesSuffix).toBe(' dice.announce.completesCard');
    expect(translate).toHaveBeenCalledWith('dice.announce.completesCard');
  });

  it('appends the turnSoFar suffix, with the kept count and running total, when dice are already kept', () => {
    const options = base({ isRolling: true, keptCount: 2, turnScore: 350 });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });

    expect(translate).toHaveBeenCalledWith('dice.announce.turnSoFar', { kept: 2, turnScore: 350 });
    const [, values] = options.announce.mock.calls[0];
    expect(values.turnSoFarSuffix).toBe(' dice.announce.turnSoFar');
  });

  it('still reports the turn\'s worth when a tutto or chain draw has reset the kept count to zero', () => {
    // CHAIN_DRAWN and a tutto's ROLL_ON_COMMITTED both reset keptDice to []
    // while turnScore carries the running total forward — the clause must
    // key off the score actually at stake, not the count of dice sitting on
    // THIS fresh table.
    const options = base({ isRolling: true, keptCount: 0, turnScore: 700 });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });

    const [, values] = options.announce.mock.calls[0];
    expect(values.turnSoFarSuffix).not.toBe('');
  });

  it('omits both suffixes when there is nothing kept and no tutto', () => {
    const options = base({ isRolling: true, keptCount: 0 });
    const { rerender } = renderHook(
      (props: UseRollAnnouncementOptions) => useRollAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isRolling: false });

    const [, values] = options.announce.mock.calls[0];
    expect(values.completesSuffix).toBe('');
    expect(values.turnSoFarSuffix).toBe('');
  });
});
