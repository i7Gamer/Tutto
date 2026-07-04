import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ReactionBar from './ReactionBar';
import { REACTION_EMOJIS } from '../../utils/reactions';

describe('ReactionBar', () => {
  it('renders one button per whitelisted emoji', () => {
    render(<ReactionBar sendReaction={vi.fn()} />);
    REACTION_EMOJIS.forEach((emoji) => {
      expect(screen.getByText(emoji)).toBeInTheDocument();
    });
  });

  it('calls sendReaction with the clicked emoji', () => {
    const sendReaction = vi.fn();
    render(<ReactionBar sendReaction={sendReaction} />);

    fireEvent.click(screen.getByText(REACTION_EMOJIS[0]));

    expect(sendReaction).toHaveBeenCalledWith(REACTION_EMOJIS[0]);
  });
});
