import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Home from './Home';

// Mock child components
vi.mock('./home/ModeSelector', () => ({
  default: () => <div data-testid="mode-selector">ModeSelector</div>
}));
vi.mock('./home/LocalLobby', () => ({
  default: () => <div data-testid="local-lobby">LocalLobby</div>
}));
vi.mock('./home/OnlineLobby', () => ({
  default: () => <div data-testid="online-lobby">OnlineLobby</div>
}));

describe('Home Component (i18n)', () => {
  it('uses translation keys for text content', () => {
    render(<Home onShowStats={() => {}} />);
    
    // We expect the translated keys because of our global react-i18next mock
    // If the component uses t('lobby.online.leaveConfirm'), it will render 'lobby.online.leaveConfirm'
    // Check if the "Clear App Cache" button uses a translation key
    expect(screen.getByText('home.clearCache')).toBeInTheDocument();
    
    // Check if the confirmation text is passed or used (if visible, but window.confirm is mocked)
    // Actually, window.confirm is inside a handler, so we can't easily query the text without triggering it.
  });
});
