import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReactionOverlay from './ReactionOverlay';
import { useGameStore } from '../store/useGameStore';

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

  // Announced through the same polite toast live region App.tsx already
  // renders, so a screen reader learns of a reaction it has no other way to
  // notice (the caption above is silent to it).
  it('announces a new reaction through the toast store', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });

    render(<ReactionOverlay />);
    expect(useGameStore.getState().toasts.map(toast => toast.message)).toEqual(['game.reacted']);
  });

  it('announces each reaction only once, however often it re-renders', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });

    const { rerender } = render(<ReactionOverlay />);
    rerender(<ReactionOverlay />);
    expect(useGameStore.getState().toasts).toHaveLength(1);
  });

  it('announces a newly added reaction without re-announcing an existing one', () => {
    useGameStore.setState({ reactions: [{ id: 1, emoji: '🔥', senderName: 'Alice' }] });
    const { rerender } = render(<ReactionOverlay />);

    useGameStore.setState({
      reactions: [
        { id: 1, emoji: '🔥', senderName: 'Alice' },
        { id: 2, emoji: '🎉', senderName: 'Bob' },
      ],
    });
    rerender(<ReactionOverlay />);

    expect(useGameStore.getState().toasts).toHaveLength(2);
  });
});
