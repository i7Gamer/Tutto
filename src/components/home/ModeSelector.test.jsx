import React from 'react';
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
});
