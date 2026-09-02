import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ModeSelector from './ModeSelector';

describe('ModeSelector Component', () => {
  it('renders translation keys', () => {
    render(
      <ModeSelector 
        mode="local" 
        onModeChange={vi.fn()} 
        onShowStats={vi.fn()} 
        hasActiveRoom={false} 
      />
    );
    
    expect(screen.getByText('home.localPlay')).toBeInTheDocument();
    expect(screen.getByText('home.onlinePlay')).toBeInTheDocument();
    expect(screen.getByText('home.viewStats')).toBeInTheDocument();
  });

  // The active mode was carried by the indigo fill alone: to anyone not
  // reading colour, the two buttons were indistinguishable. WCAG 1.4.1.
  it('says which mode is active, rather than only colouring it', () => {
    render(<ModeSelector mode="online" onModeChange={vi.fn()} onShowStats={vi.fn()} hasActiveRoom={false} />);

    expect(screen.getByRole('button', { name: /home.localPlay/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /home.onlinePlay/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves the pressed state with the mode', () => {
    const { rerender } = render(<ModeSelector mode="online" onModeChange={vi.fn()} onShowStats={vi.fn()} hasActiveRoom={false} />);
    rerender(<ModeSelector mode="local" onModeChange={vi.fn()} onShowStats={vi.fn()} hasActiveRoom={false} />);

    expect(screen.getByRole('button', { name: /home.localPlay/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /home.onlinePlay/ })).toHaveAttribute('aria-pressed', 'false');
  });
});
