import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import OnlineLobby from './OnlineLobby';
import { MAX_RECENT_ROOMS } from '../../utils/recentRooms';
import { useGameStore } from '../../store/useGameStore';
import type { GameStore } from '../../store/useGameStore';
import type { Player } from '../../types';

// OnlineLobby subscribes to the store itself (no more `game` prop), so tests
// stage state/action-spies with setState and restore the pristine snapshot
// afterwards.
const pristineStore = useGameStore.getState();
const stageStore = (partial: Partial<GameStore>) => {
  act(() => {
    useGameStore.setState(partial);
  });
};

const asPlayers = (players: Array<Partial<Player> & { name: string }>): Player[] =>
  players.map(p => ({ score: 0, ...p } as Player));

afterEach(() => {
  act(() => {
    useGameStore.setState(pristineStore, true);
  });
});

describe('OnlineLobby', () => {
  it('renders join/create room form if no roomId', () => {
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.online.joinOrCreateRoom')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.roomCode')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.yourName')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.joinCreateButton')).toBeInTheDocument();
  });

  it('renders room lobby if roomId is present', () => {
    stageStore({
      roomId: '1234',
      myName: 'Alice',
      isHost: true,
      players: asPlayers([{ name: 'Alice' }]),
    });
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.online.room')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.youAre')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.leaveRoom')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.playersInLobby')).toBeInTheDocument();
  });
});

describe('OnlineLobby join double-submit guard', () => {
  const fillJoinForm = () => {
    fireEvent.change(screen.getByPlaceholderText('lobby.online.roomCodePlaceholder'), { target: { value: 'R1' } });
    fireEvent.change(screen.getByPlaceholderText('lobby.online.yourNamePlaceholder'), { target: { value: 'Alice' } });
  };

  it('fires joinRoom only once for a rapid double-click while the ack is pending', async () => {
    let resolveJoin!: (v: { error?: string }) => void;
    const joinRoom = vi.fn(() => new Promise<{ error?: string }>(res => { resolveJoin = res; }));
    stageStore({ joinRoom: joinRoom as unknown as GameStore['joinRoom'] });

    render(<OnlineLobby />);
    fillJoinForm();

    const btn = screen.getByText('lobby.online.joinCreateButton');
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn); // second click before the server ack returns
    });

    expect(joinRoom).toHaveBeenCalledTimes(1);

    await act(async () => { resolveJoin({ error: 'nope' }); });
  });

  it('re-enables the button once a failed attempt settles, so the user can retry', async () => {
    let resolveJoin!: (v: { error?: string }) => void;
    const joinRoom = vi.fn(() => new Promise<{ error?: string }>(res => { resolveJoin = res; }));
    stageStore({ joinRoom: joinRoom as unknown as GameStore['joinRoom'] });

    render(<OnlineLobby />);
    fillJoinForm();

    await act(async () => {
      fireEvent.click(screen.getByText('lobby.online.joinCreateButton'));
    });
    await act(async () => { resolveJoin({ error: 'Username already exists in this room' }); });

    expect(screen.getByText('Username already exists in this room')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('lobby.online.joinCreateButton'));
    });
    expect(joinRoom).toHaveBeenCalledTimes(2);

    await act(async () => { resolveJoin({ error: 'nope' }); });
  });

  it('re-enables the button when the server never acks, via the join timeout watchdog', async () => {
    vi.useFakeTimers();
    // Never resolves — simulates socket.io buffering the emit with the server unreachable.
    const joinRoom = vi.fn(() => new Promise<{ error?: string }>(() => {}));
    stageStore({ joinRoom: joinRoom as unknown as GameStore['joinRoom'] });

    render(<OnlineLobby />);
    fillJoinForm();

    await act(async () => {
      fireEvent.click(screen.getByText('lobby.online.joinCreateButton'));
    });
    // While pending, the button is locked (label swaps to the joining state).
    expect(screen.queryByText('lobby.online.joinCreateButton')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText('lobby.online.joinTimeout')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.joinCreateButton')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('OnlineLobby copy room code button', () => {
  const stageRoom = (overrides: Partial<GameStore> = {}) => stageStore({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    players: asPlayers([{ name: 'Alice' }]),
    ...overrides,
  });

  it('copies the room code to the clipboard and shows a toast', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const addToast = vi.fn();
    stageRoom({ addToast });

    render(<OnlineLobby />);

    await act(async () => {
      fireEvent.click(screen.getByTitle('lobby.online.copyRoomCode'));
    });

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('1234'));
    expect(addToast).toHaveBeenCalledWith('lobby.online.roomCodeCopied');
    vi.useRealTimers();
  });

  it('shows a failure toast when the clipboard write rejects', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    const addToast = vi.fn();
    stageRoom({ addToast });

    render(<OnlineLobby />);

    await act(async () => {
      fireEvent.click(screen.getByTitle('lobby.online.copyRoomCode'));
    });

    await vi.waitFor(() => expect(addToast).toHaveBeenCalledWith('lobby.online.roomCodeCopyFailed'));
    vi.useRealTimers();
  });

  it('clears the pending copy-feedback timeout on unmount instead of leaving it armed', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    stageRoom({ addToast: vi.fn() });

    const { unmount } = render(<OnlineLobby />);

    await act(async () => {
      fireEvent.click(screen.getByTitle('lobby.online.copyRoomCode'));
    });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    // The copy-feedback timeout is now scheduled (alongside unrelated timers
    // owned by other parts of the component tree, e.g. framer-motion).
    const timersBeforeUnmount = vi.getTimerCount();
    expect(timersBeforeUnmount).toBeGreaterThan(0);

    unmount();

    // Unmounting must clear the copy-feedback timeout rather than leave it
    // armed to fire setRoomCodeCopied(false) against a gone component — so
    // exactly one fewer timer should remain pending.
    expect(vi.getTimerCount()).toBe(timersBeforeUnmount - 1);

    vi.useRealTimers();
  });
});

describe('OnlineLobby leave-room confirmation', () => {
  const stageRoom = (overrides: Partial<GameStore> = {}) => stageStore({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    players: asPlayers([{ name: 'Alice' }]),
    ...overrides,
  });

  it('does not leave the room when the confirm dialog is declined', () => {
    const leaveRoom = vi.fn();
    stageRoom({ leaveRoom });
    render(<OnlineLobby />);

    act(() => {
      fireEvent.click(screen.getByText('lobby.online.leaveRoom'));
    });
    expect(screen.getByText('lobby.online.leaveConfirm')).toBeInTheDocument();
    expect(leaveRoom).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByText('common.cancel'));
    });
    expect(leaveRoom).not.toHaveBeenCalled();
    expect(screen.queryByText('lobby.online.leaveConfirm')).toBeNull();
  });

  it('leaves the room once the confirm dialog is accepted', () => {
    const leaveRoom = vi.fn();
    stageRoom({ leaveRoom });
    render(<OnlineLobby />);

    act(() => {
      fireEvent.click(screen.getByText('lobby.online.leaveRoom'));
    });
    act(() => {
      fireEvent.click(screen.getByText('common.confirm'));
    });

    expect(leaveRoom).toHaveBeenCalledTimes(1);
  });
});

describe('OnlineLobby start button / waiting indicator', () => {
  const stageRoom = (overrides: Partial<GameStore> = {}) => stageStore({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    hostId: 'socket-alice',
    players: asPlayers([
      { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
      { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: false },
    ]),
    ...overrides,
  });

  it('renders enabled start button for host with 2+ connected players', () => {
    stageRoom();
    render(<OnlineLobby />);
    const startText = screen.getByText('lobby.startGame');
    expect(startText).toBeInTheDocument();
    expect(startText.closest('button')).not.toBeDisabled();
  });

  it('renders disabled start button with reconnect message when a player is disconnected', () => {
    stageRoom({
      players: asPlayers([
        { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
        { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: true },
      ]),
    });
    render(<OnlineLobby />);
    const msg = screen.getByText('lobby.waitingForPlayersToReconnect');
    expect(msg).toBeInTheDocument();
    expect(msg.closest('button')).toBeDisabled();
  });

  it('renders waiting-for-host spinner and no start button for non-host', () => {
    stageRoom({ isHost: false });
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.online.waitingForHost')).toBeInTheDocument();
    expect(screen.queryByText('lobby.startGame')).not.toBeInTheDocument();
  });

  it('places start button outside the mb-8 room-header section', () => {
    stageRoom();
    render(<OnlineLobby />);
    const startText = screen.getByText('lobby.startGame');
    const leaveText = screen.getByText('lobby.online.leaveRoom');
    // Leave button lives inside the mb-8 wrapper; start button must not
    expect(leaveText.closest('.mb-8')).not.toBeNull();
    expect(startText.closest('.mb-8')).toBeNull();
  });
});

describe('OnlineLobby dice mode enforcement', () => {
  const stageRoom = (overrides: Partial<GameStore> = {}) => stageStore({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    hostId: 'socket-alice',
    players: asPlayers([
      { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
      { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: false },
    ]),
    diceMode: 'physical',
    enforcedDiceMode: null,
    ...overrides,
  });

  it('host sees the enforce checkbox and their own dice mode selector', () => {
    stageRoom();
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.enforceDiceMode')).toBeInTheDocument();
    expect(screen.getByText('lobby.digitalDice')).toBeInTheDocument();
    expect(screen.getByText('lobby.physicalDice')).toBeInTheDocument();
    expect(screen.queryByText('lobby.diceModeEnforcedBadge')).not.toBeInTheDocument();
  });

  it('checking the enforce checkbox enforces the host\'s current dice mode', () => {
    const setEnforcedDiceMode = vi.fn();
    stageRoom({ diceMode: 'digital', setEnforcedDiceMode });
    render(<OnlineLobby />);

    const checkbox = screen.getByText('lobby.enforceDiceMode').closest('label')!.querySelector('input[type="checkbox"]')!;
    act(() => {
      fireEvent.click(checkbox);
    });

    expect(setEnforcedDiceMode).toHaveBeenCalledWith('digital');
  });

  it('unchecking the enforce checkbox turns enforcement off', () => {
    const setEnforcedDiceMode = vi.fn();
    stageRoom({ enforcedDiceMode: 'physical', setEnforcedDiceMode });
    render(<OnlineLobby />);

    const checkbox = screen.getByText('lobby.enforceDiceMode').closest('label')!.querySelector('input[type="checkbox"]')!;
    expect(checkbox).toBeChecked();
    act(() => {
      fireEvent.click(checkbox);
    });

    expect(setEnforcedDiceMode).toHaveBeenCalledWith(null);
  });

  it('non-host sees a read-only badge instead of the selector once enforcement is on', () => {
    stageRoom({ isHost: false, enforcedDiceMode: 'digital' });
    render(<OnlineLobby />);
    expect(screen.getByText(/lobby.diceModeEnforcedBadge/)).toBeInTheDocument();
    expect(screen.queryByText('lobby.digitalDice')).not.toBeInTheDocument();
    expect(screen.queryByText('lobby.physicalDice')).not.toBeInTheDocument();
    expect(screen.queryByText('lobby.enforceDiceMode')).not.toBeInTheDocument();
  });

  it('non-host still sees their own selector when enforcement is off', () => {
    stageRoom({ isHost: false, enforcedDiceMode: null });
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.digitalDice')).toBeInTheDocument();
    expect(screen.getByText('lobby.physicalDice')).toBeInTheDocument();
    expect(screen.queryByText(/lobby.diceModeEnforcedBadge/)).not.toBeInTheDocument();
  });
});

describe('OnlineLobby recent rooms history', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders recent rooms from localStorage if present', () => {
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: 'ROOM123', name: 'Bob', timestamp: Date.now() }
      ])
    );
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.online.recentRooms')).toBeInTheDocument();
    expect(screen.getByText(/ROOM123/)).toBeInTheDocument();
  });

  it('clicking a recent room populates the room code and name fields', () => {
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: 'ROOM123', name: 'Bob', timestamp: Date.now() }
      ])
    );
    render(<OnlineLobby />);

    const recentBtn = screen.getByText(/ROOM123/).closest('button')!;
    act(() => {
      fireEvent.click(recentBtn);
    });

    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder') as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder') as HTMLInputElement;

    expect(roomInput.value).toBe('ROOM123');
    expect(nameInput.value).toBe('Bob');
  });

  it('deduplicates recent rooms on join and moves the most recent to the top', async () => {
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: 'ROOM123', name: 'Bob', timestamp: 1000 },
        { roomId: 'ROOM456', name: 'Alice', timestamp: 2000 }
      ])
    );
    stageStore({ joinRoom: vi.fn().mockResolvedValue({ success: true }) });
    render(<OnlineLobby />);

    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder') as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder') as HTMLInputElement;
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    act(() => {
      fireEvent.change(roomInput, { target: { value: 'ROOM123' } });
      fireEvent.change(nameInput, { target: { value: 'Bob2' } });
    });

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    await waitFor(() => {
      const updatedRaw = localStorage.getItem('tutto_recent_rooms');
      const updated = JSON.parse(updatedRaw!);
      expect(updated.length).toBe(2);
      expect(updated[0].roomId).toBe('ROOM123');
      expect(updated[0].name).toBe('Bob2');
      expect(updated[1].roomId).toBe('ROOM456');
    });
  });

  it('caps recent rooms to a maximum of 5', async () => {
    const seed = Array.from({ length: 5 }).map((_, i) => ({
      roomId: `ROOM${i}`, name: 'Bob', timestamp: i * 1000
    }));
    localStorage.setItem('tutto_recent_rooms', JSON.stringify(seed));

    stageStore({ joinRoom: vi.fn().mockResolvedValue({ success: true }) });
    render(<OnlineLobby />);

    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder') as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder') as HTMLInputElement;
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    act(() => {
      fireEvent.change(roomInput, { target: { value: 'ROOM_NEW' } });
      fireEvent.change(nameInput, { target: { value: 'Bob' } });
    });

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    await waitFor(() => {
      const updatedRaw = localStorage.getItem('tutto_recent_rooms');
      const updated = JSON.parse(updatedRaw!);
      expect(updated.length).toBe(5);
      expect(updated[0].roomId).toBe('ROOM_NEW');
      expect(updated.find((r: { roomId: string }) => r.roomId === 'ROOM4')).toBeUndefined();
    });
  });

  it('handles malformed localStorage data gracefully', () => {
    localStorage.setItem('tutto_recent_rooms', 'not json');
    render(<OnlineLobby />);
    expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
  });

  it('renders when localStorage itself refuses to be read', () => {
    // Reading storage throws in real browsers — site data blocked, third-party
    // cookies blocked in an iframe, dom.storage.enabled=false. The room-code
    // and name reads three lines below have always guarded for it; the recent
    // rooms read must too, or the whole lobby goes to the ErrorBoundary.
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => render(<OnlineLobby />)).not.toThrow();
      expect(screen.getByText('lobby.online.joinOrCreateRoom')).toBeInTheDocument();
      expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('renders one row per remembered room even when the cache repeats one', () => {
    // Duplicate roomIds are duplicate React keys — the write path only removes
    // the room being joined, so an older duplicate survives in storage.
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: 'ROOM1', name: 'Bob', timestamp: 3000 },
        { roomId: 'ROOM1', name: 'Alice', timestamp: 1000 },
      ])
    );
    render(<OnlineLobby />);
    expect(screen.getAllByText(/^ROOM1$/)).toHaveLength(1);
  });

  // 'not json' above only covers the JSON.parse throw. Everything below parses
  // fine and is still not a RecentRoom[] — the shapes a hand-edited or
  // half-migrated entry actually produces. Two of them used to take the whole
  // lobby down (`.map is not a function`, and "Objects are not valid as a React
  // child"), and nothing in the app clears this key, so the ErrorBoundary's
  // reload landed on the same bad value every time.
  it('ignores a stored value that parses to a non-array', () => {
    localStorage.setItem('tutto_recent_rooms', JSON.stringify({ length: 3 }));
    render(<OnlineLobby />);
    expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
  });

  it('drops entries that are not objects', () => {
    localStorage.setItem('tutto_recent_rooms', JSON.stringify(['ROOM1', 'ROOM2']));
    render(<OnlineLobby />);
    expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
  });

  it('drops an entry whose fields are the wrong type', () => {
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: { nested: 1 }, name: 'Bob', timestamp: 1000 },
        { roomId: 'ROOM_NO_NAME', timestamp: 1000 },
        { roomId: 'ROOM_BAD_TIME', name: 'Bob', timestamp: 'yesterday' },
        { roomId: '', name: 'Bob', timestamp: 1000 },
      ])
    );
    render(<OnlineLobby />);
    expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
  });

  it('keeps the valid entries alongside invalid ones', () => {
    // Per-entry filtering, not the whole-array rejection parseSavedDiceState
    // uses: these entries are independent rows, not positionally coupled to
    // anything, so one bad row is no reason to forget every remembered room.
    localStorage.setItem(
      'tutto_recent_rooms',
      JSON.stringify([
        { roomId: 'GOOD1', name: 'Bob', timestamp: 2000 },
        { roomId: { nested: 1 }, name: 'Bob', timestamp: 1000 },
        { roomId: 'GOOD2', name: 'Alice', timestamp: 1000 },
      ])
    );
    render(<OnlineLobby />);
    expect(screen.getByText('lobby.online.recentRooms')).toBeInTheDocument();
    expect(screen.getByText(/GOOD1/)).toBeInTheDocument();
    expect(screen.getByText(/GOOD2/)).toBeInTheDocument();
  });

  it('caps an oversized stored list on read, not just on write', () => {
    // The write path trims to MAX_RECENT_ROOMS, so only an edited file gets
    // here — but without a cap on read it renders one button per entry.
    const seed = Array.from({ length: 40 }).map((_, i) => ({
      roomId: `ROOM${i}`, name: 'Bob', timestamp: i * 1000,
    }));
    localStorage.setItem('tutto_recent_rooms', JSON.stringify(seed));
    render(<OnlineLobby />);
    expect(screen.getByText(/ROOM0\b/)).toBeInTheDocument();
    expect(screen.queryByText(/ROOM39/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^ROOM\d+$/).length).toBe(MAX_RECENT_ROOMS);
  });

  it('rejects whitespace-only room code or name with error message', async () => {
    const joinRoom = vi.fn();
    stageStore({ joinRoom });
    render(<OnlineLobby />);

    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder');
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder');
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    act(() => {
      fireEvent.change(roomInput, { target: { value: '   ' } });
      fireEvent.change(nameInput, { target: { value: 'Alice' } });
    });

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    expect(screen.getByText('lobby.online.enterBoth')).toBeInTheDocument();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('trims leading and trailing whitespace from room code and name before joining and storing', async () => {
    const joinRoom = vi.fn().mockResolvedValue({ success: true });
    stageStore({ joinRoom });
    render(<OnlineLobby />);

    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder');
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder');
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    act(() => {
      fireEvent.change(roomInput, { target: { value: '  ROOM123  ' } });
      fireEvent.change(nameInput, { target: { value: '  Alice  ' } });
    });

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    expect(joinRoom).toHaveBeenCalledWith('ROOM123', 'Alice');
    expect(localStorage.getItem('tutto_last_room')).toBe('ROOM123');
    expect(localStorage.getItem('tutto_last_name')).toBe('Alice');
  });
});

