import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CurrentRollBoard from './CurrentRollBoard';

describe('CurrentRollBoard', () => {
  const dice = [{ id: 'a', val: 1, selected: true }, { id: 'b', val: 2, selected: false }];

  const baseProps = {
    displayRoll: dice,
    currentRoll: dice,
    rollingDiceIndices: new Set<string>(),
    bustState: false,
    isRolling: false,
    isSelectionLocked: false,
    hasRolled: true,
    selectionValid: true,
    selectedCount: 1,
    onToggleDie: vi.fn(),
    onSelectAllValid: vi.fn(),
  };

  it('offers Select all on a settled board and routes the click out', () => {
    const onSelectAllValid = vi.fn();
    render(<CurrentRollBoard {...baseProps} onSelectAllValid={onSelectAllValid} />);

    fireEvent.click(screen.getByText('dice.select_all_valid'));
    expect(onSelectAllValid).toHaveBeenCalledTimes(1);
  });

  it('hides Select all while dice tumble and once the roll busted', () => {
    const { rerender } = render(<CurrentRollBoard {...baseProps} isRolling />);
    expect(screen.queryByText('dice.select_all_valid')).toBeNull();

    rerender(<CurrentRollBoard {...baseProps} bustState />);
    expect(screen.queryByText('dice.select_all_valid')).toBeNull();
  });

  it('keeps the invalid-selection line mounted and only toggles its visibility', () => {
    const { rerender } = render(<CurrentRollBoard {...baseProps} selectionValid={false} selectedCount={1} />);
    expect(screen.getByText('dice.invalid_selection')).not.toHaveClass('invisible');

    // Valid again: the reserved space stays, the message goes invisible.
    rerender(<CurrentRollBoard {...baseProps} selectionValid selectedCount={1} />);
    expect(screen.getByText('dice.invalid_selection')).toHaveClass('invisible');

    // Nothing selected at all reads as neutral, not as invalid.
    rerender(<CurrentRollBoard {...baseProps} selectionValid={false} selectedCount={0} />);
    expect(screen.getByText('dice.invalid_selection')).toHaveClass('invisible');
  });

  it('replaces the invalid-selection line with the bust banner on a bust', () => {
    render(<CurrentRollBoard {...baseProps} bustState />);

    expect(screen.getByText('dice.bust_description')).toBeInTheDocument();
    expect(screen.queryByText('dice.invalid_selection')).toBeNull();
  });
});
