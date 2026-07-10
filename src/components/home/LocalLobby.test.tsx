import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import LocalLobby from './LocalLobby';
import { useGameStore } from '../../store/useGameStore';
import type { Player } from '../../types';

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
  // LocalLobby subscribes to the store itself (no more `game` prop) — stage
  // state with setState and restore the pristine snapshot afterwards.
  const pristineStore = useGameStore.getState();

  afterEach(() => {
    act(() => {
      useGameStore.setState(pristineStore, true);
    });
  });

  it('renders translation keys', () => {
    render(<LocalLobby />);
    expect(screen.getByText('lobby.playersTitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('lobby.newPlayerPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('lobby.addPlayerButton')).toBeInTheDocument();
  });

  it('disables StartGameButton when player count is less than 2', () => {
    useGameStore.setState({ players: [] });
    render(<LocalLobby />);
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'true');

    act(() => {
      useGameStore.setState({ players: [{ name: 'Alice', color: '#ff0000', score: 0 } as Player] });
    });
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'true');

    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', color: '#ff0000', score: 0 } as Player,
          { name: 'Bob', color: '#00ff00', score: 0 } as Player,
        ],
      });
    });
    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled', 'false');
  });
});
