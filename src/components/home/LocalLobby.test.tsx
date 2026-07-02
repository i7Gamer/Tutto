import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LocalLobby from './LocalLobby';

// Mock dependencies
vi.mock('./LobbyShared', () => ({
  DiceModeSelector: () => <div data-testid="dice-mode-selector" />,
  AdvancedOptionsToggle: () => <div data-testid="advanced-options-toggle" />,
  AdvancedOptionsPanel: () => <div data-testid="advanced-options-panel" />,
  StartGameButton: () => <div data-testid="start-game-button" />,
  PlayerList: () => <div data-testid="player-list" />,
  AudioSettingSelector: () => <div data-testid="audio-setting-selector" />,
}));

describe('LocalLobby', () => {
  const mockGame = {
    players: [],
    addPlayer: vi.fn(),
    removePlayer: vi.fn(),
    startGame: vi.fn(),
    winningScore: 10000,
    setWinningScore: vi.fn(),
    initialCards: 6,
    setInitialCards: vi.fn(),
    reorderPlayers: vi.fn(),
    randomOrder: false,
    setRandomOrder: vi.fn(),
    changePlayerColor: vi.fn(),
    diceMode: 'digital',
    setDiceMode: vi.fn()
  };

  it('renders translation keys', () => {
    render(<LocalLobby game={mockGame} />);
    expect(screen.getByText('lobby.playersTitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('lobby.newPlayerPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('lobby.addPlayerButton')).toBeInTheDocument();
  });
});
