import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import LocalLobby from './LocalLobby';
import { uiBusyState, _resetUiBusyStateForTests } from '../../utils/uiBusyState';
import { useGameStore } from '../../store/useGameStore';
import type { Player } from '../../types';

interface StartGameButtonProps {
  disabled?: boolean;
  disabledMessage?: string;
}

interface PlayerListCapturedProps {
  changeColor: (p: Player, color: string) => void;
  onRemovePlayer: (p: Player) => void;
}

interface PanelCapturedProps {
  onResetGeneralSettings?: (() => void) | null;
  onResetCards?: (() => void) | null;
}

// The stubs capture the props LocalLobby hands them, so the tests below can
// drive the lambdas it wires in (name-keyed colour/remove, the reset
// callbacks, the deck-gated disable) without rendering the real children —
// which have their own suites.
const captured = vi.hoisted(() => ({
  playerList: null as PlayerListCapturedProps | null,
  panel: null as PanelCapturedProps | null,
}));

// Mock dependencies
vi.mock('./LobbyShared', () => ({
  DiceModeSelector: () => <div data-testid="dice-mode-selector" />,
  RulesetSelector: () => <div data-testid="ruleset-selector" />,
  AdvancedOptionsToggle: () => <div data-testid="advanced-options-toggle" />,
  AdvancedOptionsPanel: (props: PanelCapturedProps) => {
    captured.panel = props;
    return <div data-testid="advanced-options-panel" />;
  },
  StartGameButton: (props: StartGameButtonProps) => (
    <div data-testid="start-game-button" data-disabled={props.disabled ? 'true' : 'false'} data-disabled-message={props.disabledMessage ?? ''} />
  ),
  PlayerList: (props: PlayerListCapturedProps) => {
    captured.playerList = props;
    return <div data-testid="player-list" />;
  },
  AudioSettingSelector: () => <div data-testid="audio-setting-selector" />,
  HapticsSettingSelector: () => <div data-testid="haptics-setting-selector" />,
  AnimationsSettingSelector: () => <div data-testid="animations-setting-selector" />,
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

  it('gives the Add-player button an explicit aria-label, since its text label is hidden below sm', () => {
    render(<LocalLobby />);
    const button = screen.getByRole('button', { name: 'lobby.addPlayerButton' });
    expect(button).toHaveAttribute('aria-label', 'lobby.addPlayerButton');
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

describe('LocalLobby wiring into the shared components', () => {
  const pristineStore = useGameStore.getState();

  afterEach(() => {
    captured.playerList = null;
    captured.panel = null;
    act(() => {
      useGameStore.setState(pristineStore, true);
    });
  });

  const nameInput = () => screen.getByPlaceholderText('lobby.newPlayerPlaceholder');

  it('adds the player on Enter and clears the field', () => {
    const addPlayer = vi.fn();
    useGameStore.setState({ players: [], addPlayer });
    render(<LocalLobby />);

    fireEvent.change(nameInput(), { target: { value: 'Dana' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    expect(addPlayer).toHaveBeenCalledWith('Dana');
    expect(nameInput()).toHaveValue('');
  });

  it('ignores an empty or whitespace-only name silently — no player, no toast', () => {
    const addPlayer = vi.fn();
    const addToast = vi.fn();
    useGameStore.setState({ players: [], addPlayer, addToast });
    render(<LocalLobby />);

    fireEvent.click(screen.getByText('lobby.addPlayerButton'));
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.keyDown(nameInput(), { key: 'Enter' });

    expect(addPlayer).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('keys the PlayerList colour callback by player NAME, not the object', () => {
    const changePlayerColor = vi.fn();
    useGameStore.setState({ players: [{ name: 'Alice', color: '#ff0000', score: 0 } as Player], changePlayerColor });
    render(<LocalLobby />);

    act(() => { captured.playerList!.changeColor({ name: 'Alice' } as Player, '#123456'); });

    expect(changePlayerColor).toHaveBeenCalledWith('Alice', '#123456');
  });

  it('keys the PlayerList remove callback by player NAME', () => {
    const removePlayer = vi.fn();
    useGameStore.setState({ players: [{ name: 'Alice', color: '#ff0000', score: 0 } as Player], removePlayer });
    render(<LocalLobby />);

    act(() => { captured.playerList!.onRemovePlayer({ name: 'Alice' } as Player); });

    expect(removePlayer).toHaveBeenCalledWith('Alice');
  });

  it('routes the panel reset callbacks to the store actions', () => {
    const resetGeneralSettings = vi.fn();
    const resetInitialCards = vi.fn();
    useGameStore.setState({ resetGeneralSettings, resetInitialCards });
    render(<LocalLobby />);

    act(() => {
      captured.panel!.onResetGeneralSettings!();
      captured.panel!.onResetCards!();
    });

    expect(resetGeneralSettings).toHaveBeenCalledOnce();
    expect(resetInitialCards).toHaveBeenCalledOnce();
  });

  it('disables start with the empty-deck message when the deck holds no cards', () => {
    useGameStore.setState({
      players: [
        { name: 'Alice', color: '#ff0000', score: 0 } as Player,
        { name: 'Bob', color: '#00ff00', score: 0 } as Player,
      ],
      initialCards: {},
    });
    render(<LocalLobby />);

    const button = screen.getByTestId('start-game-button');
    expect(button).toHaveAttribute('data-disabled', 'true');
    expect(button).toHaveAttribute('data-disabled-message', 'lobby.emptyDeck');
  });

  it('passes no disabled message while the deck is playable', () => {
    useGameStore.setState({
      players: [
        { name: 'Alice', color: '#ff0000', score: 0 } as Player,
        { name: 'Bob', color: '#00ff00', score: 0 } as Player,
      ],
    });
    render(<LocalLobby />);

    expect(screen.getByTestId('start-game-button')).toHaveAttribute('data-disabled-message', '');
  });
});

// A half-typed player name is component state that a service-worker reload
// would drop, exactly like the online lobby's join form (round 7, item 33).
describe('LocalLobby reports a name draft to the update idle check', () => {
  afterEach(() => { _resetUiBusyStateForTests(); });

  it('is busy while a name is typed, idle again once it is cleared or the lobby unmounts', () => {
    const { unmount } = render(<LocalLobby />);
    const input = screen.getByPlaceholderText('lobby.newPlayerPlaceholder');
    expect(uiBusyState.getState().hasFormDraft).toBe(false);

    fireEvent.change(input, { target: { value: 'Ali' } });
    expect(uiBusyState.getState().hasFormDraft).toBe(true);

    fireEvent.change(input, { target: { value: '   ' } });
    expect(uiBusyState.getState().hasFormDraft, 'whitespace is not a draft').toBe(false);

    fireEvent.change(input, { target: { value: 'Alice' } });
    unmount();
    expect(uiBusyState.getState().hasFormDraft).toBe(false);
  });
});
