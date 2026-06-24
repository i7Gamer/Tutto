import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CardDisplay from './CardDisplay';

describe('CardDisplay', () => {
  it('renders "no card" placeholder when currentCard is null', () => {
    render(<CardDisplay currentCard={null} cards={[]} />);
    expect(screen.getByText('game.noCard')).toBeInTheDocument();
  });

  it('renders the card image when currentCard is provided', () => {
    render(<CardDisplay currentCard="Stop" cards={[]} />);
    const image = screen.getByRole('img');
    expect(image).toHaveAttribute('alt', 'game.cards.Stop');
  });
});
