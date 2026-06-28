import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Die from './Die';

describe('Die', () => {
  const defaultProps = {
    die: { id: 'die-1', val: 4 },
    isSelected: false,
    isDieTumbling: false,
    bustState: false,
    onToggle: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the die value', () => {
    render(<Die {...defaultProps} />);
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('aria-label says "not selected" when not selected', () => {
    render(<Die {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Die showing 4, not selected' })).toBeInTheDocument();
  });

  it('aria-label says "selected" when selected', () => {
    render(<Die {...defaultProps} isSelected={true} />);
    expect(screen.getByRole('button', { name: 'Die showing 4, selected' })).toBeInTheDocument();
  });

  it('aria-pressed is false when not selected', () => {
    render(<Die {...defaultProps} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('aria-pressed is true when selected', () => {
    render(<Die {...defaultProps} isSelected={true} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggle with die.id when clicked', () => {
    const onToggle = vi.fn();
    render(<Die {...defaultProps} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledWith('die-1');
  });

  it('is disabled when bustState is true', () => {
    render(<Die {...defaultProps} bustState={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when isDieTumbling is true', () => {
    render(<Die {...defaultProps} isDieTumbling={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is not disabled when neither busted nor tumbling', () => {
    render(<Die {...defaultProps} />);
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('does not call onToggle when disabled due to bust', () => {
    const onToggle = vi.fn();
    render(<Die {...defaultProps} bustState={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('does not call onToggle when disabled due to tumbling', () => {
    const onToggle = vi.fn();
    render(<Die {...defaultProps} isDieTumbling={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
