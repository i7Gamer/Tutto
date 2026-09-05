import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReactionOverlay from './ReactionOverlay';
import { useGameStore } from '../store/useGameStore';

// The shared setup mock (src/setupTests.tsx) hands back a NEW `t` function
// identity on every render, which is enough on its own to exercise "does the
// once-only guard survive a re-render" — but not "does it survive the effect
// actually re-running for an unrelated reason". A stable spy here lets the
// tests below force that (a fresh `reactions` array with the same ids) and
// count real invocations, the same pattern HistoryLog.test.tsx uses.
const { translate } = vi.hoisted(() => ({
  translate: vi.fn<(key: string, opts?: Record<string, unknown>) => string>(key => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
      const cleanProps = { ...props };
      delete cleanProps.layout;
      delete cleanProps.transition;
      delete cleanProps.initial;
      delete cleanProps.animate;
      delete cleanProps.exit;
      return <div {...cleanProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
}));

describe('ReactionOverlay', () => {
  beforeEach(() => {
    useGameStore.setState({ reactions: [], toasts: [] });
    translate.mockClear();
  });

  it('renders active emoji reactions with the sender name as a tooltip', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });

    render(<ReactionOverlay />);
    const reaction = screen.getByText('🔥');
    expect(reaction).toBeInTheDocument();
    expect(reaction).toHaveAttribute('title', 'Alice');
  });

  it('renders nothing when there are no reactions', () => {
    useGameStore.setState({ reactions: [] });

    render(<ReactionOverlay />);
    expect(screen.queryByText('🔥')).not.toBeInTheDocument();
  });

  // Previously the sender's name lived only in `title` on a
  // pointer-events-none element — nothing a mouse-less or touch visitor
  // could ever trigger. It now also renders as a plain visible caption.
  it('renders the sender name as a visible caption, not just a tooltip', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });

    render(<ReactionOverlay />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  // A visible toast for every emoji reaction was unwanted — it fired for
  // every reaction anyone sent, cluttering the screen. The announcement now
  // lives in a visually hidden live region ReactionOverlay owns itself,
  // instead of going through the shared toast store at all.
  it('does not add a toast for a reaction, announcing it through its own live region instead', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });

    render(<ReactionOverlay />);

    expect(useGameStore.getState().toasts).toEqual([]);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.className).toMatch(/\bsr-only\b/);
    expect(region).toHaveTextContent('game.reacted');
  });

  it('announces each reaction only once, even once the effect re-runs for the same still-visible id', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });
    const { rerender } = render(<ReactionOverlay />);
    expect(translate.mock.calls.filter(([key]) => key === 'game.reacted')).toHaveLength(1);

    // A fresh array with the SAME id — as a re-broadcast payload might arrive
    // — changes the effect's dependency and makes it re-run; the guard
    // (keyed by id, not by array identity) must still stop a second
    // announcement.
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });
    rerender(<ReactionOverlay />);

    expect(translate.mock.calls.filter(([key]) => key === 'game.reacted')).toHaveLength(1);
    expect(useGameStore.getState().toasts).toEqual([]);
  });

  it('announces a newly added reaction without re-announcing an existing (still-visible) one', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });
    const { rerender } = render(<ReactionOverlay />);
    expect(translate.mock.calls.filter(([key]) => key === 'game.reacted')).toHaveLength(1);

    useGameStore.setState({
      reactions: [
        { id: 1, emoji: '🔥', senderName: 'Alice' },
        { id: 2, emoji: '🎉', senderName: 'Bob' },
      ],
    });
    rerender(<ReactionOverlay />);

    // Exactly one MORE call — for the new id, not a re-announcement of id 1.
    expect(translate.mock.calls.filter(([key]) => key === 'game.reacted')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('game.reacted');
  });
});
