import { render, screen, fireEvent } from '@testing-library/react';
import { PropsWithChildren, ButtonHTMLAttributes } from 'react';
import { describe, it, expect, vi } from 'vitest';
import Die, { DiePips } from './Die';
import type { Die as DieType } from '../../types';

vi.mock('framer-motion', () => ({
  motion: {
    button: ({ children, onClick, disabled, className, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => {
      const cleanProps: Record<string, unknown> = { ...props };
      delete cleanProps.animate;
      delete cleanProps.transition;
      return (
        <button onClick={onClick} disabled={disabled} className={className} {...cleanProps}>
          {children}
        </button>
      );
    },
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

  it('replaces the outline it strips with a visible focus indicator', () => {
    // The class string strips the native outline (outline-hidden,
    // focus:outline-hidden, focus:ring-0) and used to put nothing back — the
    // conditional branches below it are SELECTION state, not focus. index.css
    // styles focus for inputs/checkboxes/radios only, never buttons, so a
    // keyboard player tabbing across the six dice saw nothing change at any
    // step and could not tell which die Space would toggle (WCAG 2.4.7, AA).
    // Every other outline-stripping site in the app supplies a replacement.
    render(
      <Die die={defaultDie} isSelected={false} isDieTumbling={false} bustState={false} onToggle={() => {}} />
    );

    const button = screen.getByRole('button');
    expect(button.className).toMatch(/focus-visible:ring-2/);
    expect(button.className).toMatch(/focus-visible:ring-indigo-500/);
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

  it('renders a settled die of a still-pending roll as unclickable, not just disabled', () => {
    // A die stops tumbling before its roll finalizes, and DiceGame drops every
    // click until then — so the pointer cursor and hover highlight have to go
    // with the click, or the die keeps offering one it will swallow.
    const handleToggle = vi.fn();
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        isRollPending={true}
        onToggle={handleToggle}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button.className).not.toContain('cursor-pointer');
    expect(button.className).not.toContain('hover:border-indigo-400');
    fireEvent.click(button);
    expect(handleToggle).not.toHaveBeenCalled();
  });

  it('renders a die the card will not let you toggle as unclickable', () => {
    // Official Feuerwerk keeps every scoring die: the selection is forced and
    // toggleDie is a no-op for that card. Same mismatch as the pending roll —
    // the die must not look clickable when the click cannot land.
    const handleToggle = vi.fn();
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        isSelectionLocked={true}
        onToggle={handleToggle}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button.className).not.toContain('cursor-pointer');
    expect(button.className).not.toContain('hover:border-indigo-400');
    fireEvent.click(button);
    expect(handleToggle).not.toHaveBeenCalled();
  });

  it('rounds the die corners (Tailwind class, not a legacy stylesheet rule)', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByRole('button').className).toMatch(/\brounded-\w+\b/);
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

  it('applies text-transparent class to visually hide text numbers', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        onToggle={() => {}}
      />
    );
    const button = screen.getByRole('button');
    expect(button.className).toContain('text-transparent');
  });

  it('ensures die text is transparent (via class, not inline style)', () => {
    render(
      <Die
        die={defaultDie}
        isSelected={false}
        isDieTumbling={false}
        bustState={false}
        onToggle={() => {}}
      />
    );
    const button = screen.getByRole('button');
    // Should have text-transparent class for transparency
    expect(button.className).toContain('text-transparent');
    // Should NOT have redundant inline color style
    expect(button.style.color).not.toBe('transparent');
  });

  describe('DiePips', () => {
    it('renders DiePips with large size layout by default', () => {
      const { container } = render(
        <DiePips val={5} isSelected={false} bustState={false} />
      );
      const grid = container.firstChild as HTMLElement;
      expect(grid.className).toContain('gap-1');
      expect(grid.className).toContain('p-2.5');
    });

    it('renders DiePips with small size layout when specified', () => {
      const { container } = render(
        <DiePips val={5} isSelected={false} bustState={false} size="small" />
      );
      const grid = container.firstChild as HTMLElement;
      expect(grid.className).toContain('gap-0.5');
      expect(grid.className).toContain('p-1.5');
    });

    it('renders DiePips with white pips when isIndigo is true', () => {
      const { container } = render(
        <DiePips val={5} isSelected={false} bustState={false} size="small" isIndigo={true} />
      );
      const pips = container.querySelectorAll('.bg-white');
      expect(pips.length).toBeGreaterThan(0);
    });
  });
});
