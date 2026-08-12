import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DrawnCardReveal from './DrawnCardReveal';

describe('DrawnCardReveal', () => {
  const baseProps = {
    card: '500',
    chainCardCount: 2,
    turnScore: 1800,
    onContinue: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names what was drawn and which card of the chain it is', () => {
    render(<DrawnCardReveal {...baseProps} />);

    expect(screen.getByText('dice.drawn_card_title')).toBeInTheDocument();
    expect(screen.getByText('dice.chain_card_count')).toBeInTheDocument();
  });

  it('renders the drawn card itself, not just its name', () => {
    const { container } = render(<DrawnCardReveal {...baseProps} />);

    expect(container.querySelector('.tutto-card.c-500')).not.toBeNull();
  });

  it('shows the accumulated total the new card puts at risk', () => {
    render(<DrawnCardReveal {...baseProps} />);

    expect(screen.getByText('dice.points_at_risk')).toBeInTheDocument();
    expect(screen.getByText('1800')).toBeInTheDocument();
  });

  it('shows a zero total rather than hiding the line', () => {
    // A chain whose first card scored nothing still draws on a real total —
    // "at risk: 0" is information, an absent line is a missing answer.
    render(<DrawnCardReveal {...baseProps} turnScore={0} />);

    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('resumes the turn on continue', () => {
    render(<DrawnCardReveal {...baseProps} />);

    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    expect(baseProps.onContinue).toHaveBeenCalledOnce();
  });

  it('reveals a drawn Stop like any other card', () => {
    // The forfeit summary follows it — the reveal's job is only that the
    // player sees which card ended their chain.
    const { container } = render(<DrawnCardReveal {...baseProps} card="Stop" />);

    expect(container.querySelector('.tutto-card.c-Stop')).not.toBeNull();
    expect(screen.getByTestId('drawn-card-continue')).toBeInTheDocument();
  });
});
