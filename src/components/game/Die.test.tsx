import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Die from './Die';
import type { Die as DieType } from '../../types';

vi.mock('framer-motion', () => ({
  motion: {
    button: ({ children, onClick, disabled, className, ...props }: React.PropsWithChildren<any>) => (
      <button onClick={onClick} disabled={disabled} className={className} {...props}>
        {children}
      </button>
    ),
  },
}));

describe('Die', () => {
  const defaultDie: DieType = { id: 'die-1', val: 5, selected: false };

  it('renders the die value text (hidden/transparent by CSS but present)', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('calls onToggle with die ID when clicked', () => {
    const handleToggle = vi.fn();
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        onToggle={handleToggle}
      />
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(handleToggle).toHaveBeenCalledWith('die-1');
  });

  it('disables button when tumbling or busted', () => {
    const { rerender } = render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={true}
        bustState={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByRole('button')).toBeDisabled();

    rerender(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={true}
        onToggle={() => {}}
      />
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies correct styling classes for selected state', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={true}
        isDieTumbling={false}
        bustState={false}
        onToggle={() => {}}
      />
    );
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-emerald-100');
    expect(button.className).toContain('border-emerald-500');
  });

  it('applies correct styling classes for bust state', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={true}
        onToggle={() => {}}
      />
    );
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-red-50');
    expect(button.className).toContain('border-red-300');
  });
});
