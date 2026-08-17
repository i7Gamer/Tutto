import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import KeptDiceTray from './KeptDiceTray';

describe('KeptDiceTray', () => {
  it('renders one die per kept die, as pip faces', () => {
    render(<KeptDiceTray keptDice={[{ id: 'a', val: 1 }, { id: 'b', val: 5 }]} />);

    const dice = screen.getAllByTestId('die');
    expect(dice).toHaveLength(2);
    // Pips, not raw digits — same style as the current-roll dice.
    expect(screen.queryByText('1')).toBeNull();
    expect(screen.queryByText('5')).toBeNull();
  });

  // The face is drawn as pips — SVG circles with no text — so a die carried
  // no accessible name at all: a screen reader user could hear that a turn was
  // scored but never which dice were banked to score it.
  it('names each kept die for a screen reader', () => {
    render(<KeptDiceTray keptDice={[{ id: 'a', val: 3 }, { id: 'b', val: 6 }]} />);

    const named = screen.getAllByRole('img');
    expect(named).toHaveLength(2);
    named.forEach(die => expect(die).toHaveAttribute('aria-label'));
  });

  it('shows the empty label when nothing is kept yet', () => {
    render(<KeptDiceTray keptDice={[]} />);

    expect(screen.getByText('dice.none')).toBeInTheDocument();
    expect(screen.queryAllByTestId('die')).toHaveLength(0);
  });
});
