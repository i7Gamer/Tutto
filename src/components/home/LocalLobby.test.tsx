import { render, screen, act, fireEvent } from '@testing-library/react';
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

describe('LocalLobby handleAddPlayer name validation', () => {
  const pristineStore = useGameStore.getState();

  afterEach(() => {
    act(() => {
      useGameStore.setState(pristineStore, true);
    });
  });

  const addPlayerViaInput = (name: string) => {
    fireEvent.change(screen.getByPlaceholderText('lobby.newPlayerPlaceholder'), { target: { value: name } });
    fireEvent.click(screen.getByText('lobby.addPlayerButton'));
  };

  it('rejects an over-length name with a toast instead of adding it', () => {
    const addPlayer = vi.fn();
    const addToast = vi.fn();
    useGameStore.setState({ players: [], addPlayer, addToast });
    render(<LocalLobby />);

    addPlayerViaInput('x'.repeat(31));

    expect(addPlayer).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('lobby.playerNameTooLongAlert');
  });

  it('accepts a name exactly at the length cap', () => {
    const addPlayer = vi.fn();
    useGameStore.setState({ players: [], addPlayer });
    render(<LocalLobby />);

    addPlayerViaInput('x'.repeat(30));

    expect(addPlayer).toHaveBeenCalledWith('x'.repeat(30));
  });

  it('rejects a duplicate name (case-insensitive) with a toast instead of window.alert', () => {
    const addPlayer = vi.fn();
    const addToast = vi.fn();
    const alertSpy = vi.spyOn(window, 'alert');
    useGameStore.setState({
      players: [{ name: 'Alice', color: '#ff0000', score: 0 } as Player],
      addPlayer,
      addToast,
    });
    render(<LocalLobby />);

    addPlayerViaInput('alice');

    expect(addPlayer).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('lobby.playerExistsAlert');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
