import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CardDisplay from './CardDisplay';

describe('CardDisplay', () => {
  describe('no-card state', () => {
    it('renders the placeholder text when currentCard is null', () => {
      render(<CardDisplay currentCard={null} cards={[]} />);
      expect(screen.getByText('game.noCard')).toBeInTheDocument();
    });

    it('does not render a .tutto-card when currentCard is null', () => {
      const { container } = render(<CardDisplay currentCard={null} cards={[]} />);
      expect(container.querySelector('.tutto-card')).not.toBeInTheDocument();
    });
  });

  describe('active card state', () => {
    it('does not render the placeholder when a card is active', () => {
      render(<CardDisplay currentCard="Stop" cards={[]} />);
      expect(screen.queryByText('game.noCard')).not.toBeInTheDocument();
    });

    it('renders the card face when currentCard is provided', () => {
      const { container } = render(<CardDisplay currentCard="Stop" cards={[]} />);
      expect(container.querySelector('.tutto-card.c-Stop')).toBeInTheDocument();
    });

    it.each([
      'Kniffel', 'Plus_Minus', 'x2',
      '200', '300', '400', '500', '600',
      'Feuerwerk', 'Kleeblatt', 'Stop',
    ])('renders card type %s with correct class', (cardType) => {
      const { container } = render(<CardDisplay currentCard={cardType} cards={[]} />);
      expect(container.querySelector(`.tutto-card.c-${cardType}`)).toBeInTheDocument();
    });
  });
});
