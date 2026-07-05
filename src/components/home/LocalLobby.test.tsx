import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LocalLobby from './LocalLobby';
import type { GameStore } from '../../store/useGameStore';

interface StartGameButtonProps {
  disabled?: boolean;
}

// Mock dependencies
vi.mock('./LobbyShared', () => ({
  DiceModeSelector: () => <div data-testid="dice-mode-selector" />,
  AdvancedOptionsToggle: () => <div data-testid="advanced-options-toggle" />,
  AdvancedOptionsPanel: () => <div data-testid="advanced-options-panel" />,
  StartGameButton: (props: StartGameButtonProps) => (
    <div data-testid="start-game-button" data-disabled={props.disabled ? 'true' : 'false'} />
  ),
  PlayerList: () => <div data-testid="player-list" />,
  AudioSettingSelector: () => <div data-testid="audio-setting-selector" />,
  HapticsSettingSelector: () => <div data-testid="haptics-setting-selector" />,
}));

describe('LocalLobby', () => {
  const mockGame: Partial<GameStore> = {
    players: [],
    addPlayer: vi.fn(),
    removePlayer: vi.fn(),
    startGame: vi.fn(),
    winningScore: 10000,
    setWinningScore: vi.fn(),
    initialCards: { '100': 1 },
    setInitialCards: vi.fn(),
    reorderPlayers: vi.fn(),
    randomOrder: false,
    setRandomOrder: vi.fn(),
    changePlayerColor: vi.fn(),
    diceMode: 'digital',
    setDiceMode: vi.fn()
  };

  it('renders translation keys', () => {
    render(<LocalLobby game={mockGame as GameStore} />);
    expect(screen.getByText('lobby.playersTitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('lobby.newPlayerPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('lobby.addPlayerButton')).toBeInTheDocument();
  });

  it('disables StartGameButton when player count is less than 2', () => {
    const gameWithNoPlayers = {
      ...mockGame,
      players: [],
    };
    const { rerender } = render(<LocalLobby game={gameWithNoPlayers as GameStore} />);
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'true');

    const gameWithOnePlayer = {
      ...mockGame,
      players: [{ name: 'Alice', color: '#ff0000', id: '1' }],
    };
    rerender(<LocalLobby game={gameWithOnePlayer as GameStore} />);
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'true');

    const gameWithTwoPlayers = {
      ...mockGame,
      players: [
        { name: 'Alice', color: '#ff0000', id: '1' },
        { name: 'Bob', color: '#00ff00', id: '2' },
      ],
    };
    rerender(<LocalLobby game={gameWithTwoPlayers as GameStore} />);
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'false');
  });
});
