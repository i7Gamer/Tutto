import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTurnAnnouncement, type UseTurnAnnouncementOptions } from './useTurnAnnouncement';

describe('useTurnAnnouncement', () => {
  const base = (over: Partial<UseTurnAnnouncementOptions> = {}): UseTurnAnnouncementOptions => ({
    isOnline: true,
    isMyTurn: false,
    addToast: vi.fn(),
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('announces once when an online turn flips from someone else\'s to mine', () => {
    const options = base({ isMyTurn: false });
    const { rerender } = renderHook(
      (props: UseTurnAnnouncementOptions) => useTurnAnnouncement(props),
      { initialProps: options },
    );
    expect(options.addToast).not.toHaveBeenCalled();

    rerender({ ...options, isMyTurn: true });
    expect(options.addToast).toHaveBeenCalledTimes(1);
    expect(options.addToast).toHaveBeenCalledWith('game.yourTurn');
  });

  it('does not announce for a fresh mount that is already my turn', () => {
    // Loading straight into your own turn (a fresh join, a reconnect) is not
    // itself a "turn started" transition — only a later false-to-true flip is.
    const options = base({ isMyTurn: true });
    renderHook(() => useTurnAnnouncement(options));
    expect(options.addToast).not.toHaveBeenCalled();
  });

  it('does not announce when the turn moves to someone else', () => {
    const options = base({ isMyTurn: true });
    const { rerender } = renderHook(
      (props: UseTurnAnnouncementOptions) => useTurnAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isMyTurn: false });
    expect(options.addToast).not.toHaveBeenCalled();
  });

  it('announces again on a later transition, not just the first one', () => {
    const options = base({ isMyTurn: false });
    const { rerender } = renderHook(
      (props: UseTurnAnnouncementOptions) => useTurnAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isMyTurn: true });
    rerender({ ...options, isMyTurn: false });
    rerender({ ...options, isMyTurn: true });
    expect(options.addToast).toHaveBeenCalledTimes(2);
  });

  it('never announces in local mode, even across a turn transition', () => {
    const options = base({ isOnline: false, isMyTurn: false });
    const { rerender } = renderHook(
      (props: UseTurnAnnouncementOptions) => useTurnAnnouncement(props),
      { initialProps: options },
    );
    rerender({ ...options, isMyTurn: true });
    expect(options.addToast).not.toHaveBeenCalled();
  });
});
