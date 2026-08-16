import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TurnActionBar from './TurnActionBar';

describe('TurnActionBar', () => {
  const baseProps = {
    show: true,
    actionable: true,
    isRollAgainApplicable: true,
    canStop: true,
    stopButtonText: 'Stop & Score',
    canDrawAfterTutto: false,
    onAction: vi.fn(),
  };

  it('routes each button to its action', () => {
    const onAction = vi.fn();
    render(<TurnActionBar {...baseProps} canDrawAfterTutto onAction={onAction} />);

    fireEvent.click(screen.getByText('dice.roll_again'));
    fireEvent.click(screen.getByText('Stop & Score'));
    fireEvent.click(screen.getByTestId('draw-next-card'));

    expect(onAction.mock.calls.map(c => c[0])).toEqual(['roll', 'stop', 'draw']);
  });

  it('renders nothing before the first roll lands', () => {
    render(<TurnActionBar {...baseProps} show={false} />);

    expect(screen.queryByText('dice.roll_again')).toBeNull();
  });

  it('disables in place instead of unmounting while not actionable', () => {
    const onAction = vi.fn();
    render(<TurnActionBar {...baseProps} actionable={false} onAction={onAction} />);

    const stop = screen.getByText('Stop & Score').closest('button') as HTMLButtonElement;
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('mounts only the buttons the turn offers', () => {
    render(<TurnActionBar {...baseProps} isRollAgainApplicable={false} canStop canDrawAfterTutto={false} />);

    expect(screen.queryByText('dice.roll_again')).toBeNull();
    expect(screen.getByText('Stop & Score')).toBeInTheDocument();
    expect(screen.queryByTestId('draw-next-card')).toBeNull();
  });
});
