import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Home from './Home';
import { useGameStore } from '../store/useGameStore';

// Mock child components. ModeSelector is intentionally left un-mocked below —
// it's the only way to trigger Home's handleModeChange (its own tests cover
// the presentational rendering; these tests cover Home's confirm/mode-switch
// logic that sits behind its buttons).
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

describe('Home handleModeChange', () => {
  // Captured once, before any test below overwrites them on the shared store.
  const originalSetMode = useGameStore.getState().setMode;
  const originalLeaveRoom = useGameStore.getState().leaveRoom;

  afterEach(() => {
    cleanup();
    useGameStore.setState({ setMode: originalSetMode, leaveRoom: originalLeaveRoom, roomId: null, mode: 'local' });
    vi.restoreAllMocks();
  });

  it('switches to online mode directly (no confirm) when not currently in a room', () => {
    const setMode = vi.fn();
    useGameStore.setState({ mode: 'local', roomId: null, setMode });
    render(<Home onShowStats={() => {}} />);

    fireEvent.click(screen.getByText('home.onlinePlay'));

    expect(setMode).toHaveBeenCalledWith('online');
  });

  it('switches to local mode directly (no confirm) when online but not in an active room', () => {
    const setMode = vi.fn();
    useGameStore.setState({ mode: 'online', roomId: null, setMode });
    render(<Home onShowStats={() => {}} />);

    fireEvent.click(screen.getByText('home.localPlay'));

    expect(setMode).toHaveBeenCalledWith('local');
  });

  it('does not leave or switch mode when the leave-room confirm is declined', () => {
    const setMode = vi.fn();
    const leaveRoom = vi.fn();
    useGameStore.setState({ mode: 'online', roomId: 'ROOM1', setMode, leaveRoom });
    render(<Home onShowStats={() => {}} />);

    fireEvent.click(screen.getByText('home.localPlay'));

    expect(screen.getByText('lobby.online.leaveConfirm')).toBeInTheDocument();
    expect(leaveRoom).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(leaveRoom).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(screen.queryByText('lobby.online.leaveConfirm')).toBeNull();
  });

  it('leaves the room and switches to local mode when the leave-room confirm is accepted', () => {
    const setMode = vi.fn();
    const leaveRoom = vi.fn();
    useGameStore.setState({ mode: 'online', roomId: 'ROOM1', setMode, leaveRoom });
    render(<Home onShowStats={() => {}} />);

    fireEvent.click(screen.getByText('home.localPlay'));
    fireEvent.click(screen.getByText('common.confirm'));

    expect(leaveRoom).toHaveBeenCalledTimes(1);
    expect(setMode).toHaveBeenCalledWith('local');
  });
});

describe('Home handleClearCache', () => {
  beforeEach(() => {
    localStorage.setItem('tutto_dice_turn_state', 'x');
    localStorage.setItem('tutto_local_game', 'x');
    localStorage.setItem('last_crash_time', 'x');
    sessionStorage.setItem('tutto_online_session', 'x');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('clears the known storage keys, deletes every cache, and reloads', async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });
    const deleteMock = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['cache-a', 'cache-b']), delete: deleteMock });

    render(<Home onShowStats={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText('home.clearCache'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(localStorage.getItem('tutto_local_game')).toBeNull();
    expect(localStorage.getItem('last_crash_time')).toBeNull();
    expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
    expect(deleteMock).toHaveBeenCalledWith('cache-a');
    expect(deleteMock).toHaveBeenCalledWith('cache-b');
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('still reloads even if deleting the caches fails', async () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['cache-a']),
      delete: vi.fn().mockRejectedValue(new Error('delete failed')),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<Home onShowStats={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText('home.clearCache'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('reloads directly, without touching caches, when the Cache Storage API is unavailable (e.g. insecure http:// origin)', async () => {
    // The Cache Storage API is only exposed on secure contexts (HTTPS/localhost).
    // This app is explicitly played over plain http:// on a LAN (see DiceGame.tsx),
    // where `caches` is undefined — referencing it directly would throw before
    // the reload below ever ran.
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });
    vi.stubGlobal('caches', undefined);

    render(<Home onShowStats={() => {}} />);
    expect(() => fireEvent.click(screen.getByText('home.clearCache'))).not.toThrow();

    expect(localStorage.getItem('tutto_dice_turn_state')).toBeNull();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
