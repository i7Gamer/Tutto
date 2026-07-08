import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, it, expect, vi } from 'vitest';
import ReactionOverlay from './ReactionOverlay';
import { useGameStore } from '../store/useGameStore';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
}));

describe('ReactionOverlay', () => {
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
});
