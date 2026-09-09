import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DrawnCardReveal from './DrawnCardReveal';
import { playCardSwoosh } from '../../utils/soundEffects';
import type { CardType } from '../../types';

vi.mock('../../utils/soundEffects', () => ({ playCardSwoosh: vi.fn() }));

describe('DrawnCardReveal', () => {
  const baseProps = {
    card: '500' as CardType,
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

  it('anchors keyboard focus on its continue button', () => {
    // The draw button that opened this reveal unmounts with the dice table,
    // which would drop focus to <body> — outside the dialog's tab order.
    render(<DrawnCardReveal {...baseProps} />);
    expect(screen.getByTestId('drawn-card-continue')).toHaveFocus();
  });

  it('swooshes once as the card turns over, not again on a re-render', () => {
    const { rerender } = render(<DrawnCardReveal {...baseProps} />);
    expect(playCardSwoosh).toHaveBeenCalledTimes(1);

    rerender(<DrawnCardReveal {...baseProps} turnScore={2300} />);
    expect(playCardSwoosh).toHaveBeenCalledTimes(1);
  });

  it('resumes the turn on continue', () => {
    render(<DrawnCardReveal {...baseProps} />);

    fireEvent.click(screen.getByTestId('drawn-card-continue'));

    expect(baseProps.onContinue).toHaveBeenCalledOnce();
  });

  it.each(['500', 'Stop'] as const)('keeps focus in the owning dialog when %s continuation removes the reveal', card => {
    const onContinue = vi.fn(() => view.rerender(
      <div role="dialog" aria-modal="true" tabIndex={-1}><p>Next turn view</p></div>,
    ));
    const view = render(
      <div role="dialog" aria-modal="true" tabIndex={-1}>
        <DrawnCardReveal {...baseProps} card={card} onContinue={onContinue} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('does not reclaim focus from a stacked confirmation when continuation fires', () => {
    render(<>
      <div role="dialog" aria-modal="true" tabIndex={-1}>
        <DrawnCardReveal {...baseProps} />
      </div>
      <div role="alertdialog" aria-modal="true"><button>Cancel confirmation</button></div>
    </>);
    const cancel = screen.getByRole('button', { name: 'Cancel confirmation' });
    cancel.focus();
    fireEvent.click(screen.getByTestId('drawn-card-continue'));
    expect(cancel).toHaveFocus();
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
