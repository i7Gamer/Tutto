import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CardDisplay from './CardDisplay';
import type { CardType } from '../../types';

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
    ] as CardType[])('renders card type %s with correct class', (cardType) => {
      const { container } = render(<CardDisplay currentCard={cardType} cards={[]} />);
      expect(container.querySelector(`.tutto-card.c-${cardType}`)).toBeInTheDocument();
    });
  });

  describe('the auto-continue countdown (Stop card, online, my turn)', () => {
    // Mirrors the dice summary's own "Continuing in N…" cue (DiceSummary.tsx)
    // so an online Stop card no longer advances the turn in silence — see
    // useStopCardAutoContinue, which supplies this prop only while armed.
    it('shows the countdown text when stopCardCountdown is a number', () => {
      render(<CardDisplay currentCard="Stop" cards={[]} stopCardCountdown={4} />);
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('renders no countdown text when stopCardCountdown is null (offline, or not armed)', () => {
      render(<CardDisplay currentCard="Stop" cards={[]} stopCardCountdown={null} />);
      expect(screen.queryByText('dice.auto_continuing')).not.toBeInTheDocument();
    });

    it('renders no countdown text when the prop is omitted entirely', () => {
      render(<CardDisplay currentCard="Stop" cards={[]} />);
      expect(screen.queryByText('dice.auto_continuing')).not.toBeInTheDocument();
    });
  });

  describe('announcing the card', () => {
    // CardFace names the card, which makes it inspectable — but a
    // screen-reader user with focus elsewhere has no reason to go and read it,
    // and the card decides the scoring rule for the whole turn. The live
    // region is what turns a flip into something they are told about.
    it('is a polite live region, so a flip is announced and not merely readable', () => {
      render(<CardDisplay currentCard="Stop" cards={[]} />);

      const region = screen.getByRole('status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(within(region).getByRole('img')).toHaveAccessibleName('Stop');
    });

    it('keeps the region mounted with no card, so the first draw is announced too', () => {
      // A region that appears at the same moment as its content is not
      // reliably announced — it has to be there before the change.
      render(<CardDisplay currentCard={null} cards={[]} />);

      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });
});
