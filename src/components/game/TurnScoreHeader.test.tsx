import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import TurnScoreHeader from './TurnScoreHeader';

describe('TurnScoreHeader', () => {
  const baseProps = {
    turnScore: 300,
    pendingSelectionScore: 0,
    isClassic: false,
    chainCardCount: 1,
    currentCard: '300' as const,
    tuttosThisTurn: 0,
  };

  it('shows the running total plus what the selection would add', () => {
    render(<TurnScoreHeader {...baseProps} pendingSelectionScore={150} />);

    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('450');
  });

  it('groups a four-digit running total the way the rest of the app does', () => {
    // The unit i18n mock reports language "en", so en-US grouping applies.
    render(<TurnScoreHeader {...baseProps} turnScore={2000} pendingSelectionScore={500} />);

    expect(screen.getByTestId('dice-current-score')).toHaveTextContent('2,500');
  });

  it('shows the chain badge only from the second classic card on', () => {
    const { rerender } = render(<TurnScoreHeader {...baseProps} isClassic chainCardCount={1} />);
    expect(screen.queryByText('dice.chain_card_count')).toBeNull();

    rerender(<TurnScoreHeader {...baseProps} isClassic chainCardCount={2} />);
    expect(screen.getByText('dice.chain_card_count')).toBeInTheDocument();
  });

  it('never shows the chain badge under modernized rules', () => {
    render(<TurnScoreHeader {...baseProps} isClassic={false} chainCardCount={3} />);

    expect(screen.queryByText('dice.chain_card_count')).toBeNull();
  });

  it('shows the Tutto counter on Kleeblatt and nowhere else', () => {
    const { rerender } = render(<TurnScoreHeader {...baseProps} currentCard="Kleeblatt" tuttosThisTurn={1} />);
    expect(screen.getByText('dice.tuttos_count')).toBeInTheDocument();

    rerender(<TurnScoreHeader {...baseProps} currentCard="x2" />);
    expect(screen.queryByText('dice.tuttos_count')).toBeNull();
  });

  // The running total is the one number a player tracks through a turn, and it
  // changed silently. The region has to be the stable wrapper, not the number
  // itself: that element is keyed by turnScore and so remounts on every
  // change, and a live region that appears with its content is not announced.
  it('announces the running total politely from a stable region', () => {
    const { rerender } = render(<TurnScoreHeader {...baseProps} turnScore={300} pendingSelectionScore={0} />);

    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('300');

    rerender(<TurnScoreHeader {...baseProps} turnScore={800} pendingSelectionScore={0} />);
    expect(screen.getByRole('status'), 'the region must survive the score change').toBe(region);
    expect(region).toHaveTextContent('800');
  });
});
