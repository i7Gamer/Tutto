import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OnlineLobby from './OnlineLobby';
import type { GameStore } from '../../store/useGameStore';

describe('OnlineLobby', () => {
  it('renders join/create room form if no roomId', () => {
    const mockGame = {
      joinRoom: vi.fn(),
    };
    render(<OnlineLobby game={mockGame} />);
    expect(screen.getByText('lobby.online.joinOrCreateRoom')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.roomCode')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.yourName')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.joinCreateButton')).toBeInTheDocument();
  });

  it('renders room lobby if roomId is present', () => {
    const mockGame = {
      roomId: '1234',
      myName: 'Alice',
      isHost: true,
      players: [{ id: 1, name: 'Alice' }],
      diceMode: '2d',
      setDiceMode: vi.fn(),
      changeMyColor: vi.fn(),
      kickPlayer: vi.fn(),
    };
    render(<OnlineLobby game={mockGame} />);
    expect(screen.getByText('lobby.online.room')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.youAre')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.leaveRoom')).toBeInTheDocument();
    expect(screen.getByText('lobby.online.playersInLobby')).toBeInTheDocument();
  });
});

describe('OnlineLobby copy room code button', () => {
  const makeGame = (overrides = {}) => ({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    players: [{ name: 'Alice' }],
    diceMode: 'digital',
    setDiceMode: vi.fn(),
    changeMyColor: vi.fn(),
    kickPlayer: vi.fn(),
    addToast: vi.fn(),
    ...overrides,
  });

  it('copies the room code to the clipboard and shows a toast', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const addToast = vi.fn();

    render(<OnlineLobby game={makeGame({ addToast })} />);
    
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

    render(<OnlineLobby game={makeGame({ addToast })} />);
    
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

    const { unmount } = render(<OnlineLobby game={makeGame()} />);

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

describe('OnlineLobby start button / waiting indicator', () => {
  const makeGame = (overrides = {}) => ({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    hostId: 'socket-alice',
    players: [
      { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
      { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: false },
    ],
    diceMode: 'digital',
    setDiceMode: vi.fn(),
    changeMyColor: vi.fn(),
    kickPlayer: vi.fn(),
    startGame: vi.fn(),
    reorderPlayers: vi.fn(),
    initialCards: { Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5, x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5 },
    ...overrides,
  });

  it('renders enabled start button for host with 2+ connected players', () => {
    render(<OnlineLobby game={makeGame()} />);
    const startText = screen.getByText('lobby.startGame');
    expect(startText).toBeInTheDocument();
    expect(startText.closest('button')).not.toBeDisabled();
  });

  it('renders disabled start button with reconnect message when a player is disconnected', () => {
    const game = makeGame({
      players: [
        { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
        { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: true },
      ],
    });
    render(<OnlineLobby game={game} />);
    const msg = screen.getByText('lobby.waitingForPlayersToReconnect');
    expect(msg).toBeInTheDocument();
    expect(msg.closest('button')).toBeDisabled();
  });

  it('renders waiting-for-host spinner and no start button for non-host', () => {
    render(<OnlineLobby game={makeGame({ isHost: false })} />);
    expect(screen.getByText('lobby.online.waitingForHost')).toBeInTheDocument();
    expect(screen.queryByText('lobby.startGame')).not.toBeInTheDocument();
  });

  it('places start button outside the mb-8 room-header section', () => {
    render(<OnlineLobby game={makeGame()} />);
    const startText = screen.getByText('lobby.startGame');
    const leaveText = screen.getByText('lobby.online.leaveRoom');
    // Leave button lives inside the mb-8 wrapper; start button must not
    expect(leaveText.closest('.mb-8')).not.toBeNull();
    expect(startText.closest('.mb-8')).toBeNull();
  });
});

describe('OnlineLobby dice mode enforcement', () => {
  const makeGame = (overrides = {}) => ({
    roomId: '1234',
    myName: 'Alice',
    isHost: true,
    hostId: 'socket-alice',
    players: [
      { name: 'Alice', socketId: 'socket-alice', color: '#ff0000', disconnected: false },
      { name: 'Bob',   socketId: 'socket-bob',   color: '#00ff00', disconnected: false },
    ],
    diceMode: 'physical',
    setDiceMode: vi.fn(),
    enforcedDiceMode: null,
    setEnforcedDiceMode: vi.fn(),
    changeMyColor: vi.fn(),
    kickPlayer: vi.fn(),
    startGame: vi.fn(),
    reorderPlayers: vi.fn(),
    initialCards: { Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5, x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5 },
    ...overrides,
  });

  it('host sees the enforce checkbox and their own dice mode selector', () => {
    render(<OnlineLobby game={makeGame()} />);
    expect(screen.getByText('lobby.enforceDiceMode')).toBeInTheDocument();
    expect(screen.getByText('lobby.digitalDice')).toBeInTheDocument();
    expect(screen.getByText('lobby.physicalDice')).toBeInTheDocument();
    expect(screen.queryByText('lobby.diceModeEnforcedBadge')).not.toBeInTheDocument();
  });

  it('checking the enforce checkbox enforces the host\'s current dice mode', () => {
    const setEnforcedDiceMode = vi.fn();
    render(<OnlineLobby game={makeGame({ diceMode: 'digital', setEnforcedDiceMode })} />);

    const checkbox = screen.getByText('lobby.enforceDiceMode').closest('label')!.querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);

    expect(setEnforcedDiceMode).toHaveBeenCalledWith('digital');
  });

  it('unchecking the enforce checkbox turns enforcement off', () => {
    const setEnforcedDiceMode = vi.fn();
    render(<OnlineLobby game={makeGame({ enforcedDiceMode: 'physical', setEnforcedDiceMode })} />);

    const checkbox = screen.getByText('lobby.enforceDiceMode').closest('label')!.querySelector('input[type="checkbox"]')!;
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);

    expect(setEnforcedDiceMode).toHaveBeenCalledWith(null);
  });

  it('non-host sees a read-only badge instead of the selector once enforcement is on', () => {
    render(<OnlineLobby game={makeGame({ isHost: false, enforcedDiceMode: 'digital' })} />);
    expect(screen.getByText(/lobby.diceModeEnforcedBadge/)).toBeInTheDocument();
    expect(screen.queryByText('lobby.digitalDice')).not.toBeInTheDocument();
    expect(screen.queryByText('lobby.physicalDice')).not.toBeInTheDocument();
    expect(screen.queryByText('lobby.enforceDiceMode')).not.toBeInTheDocument();
  });

  it('non-host still sees their own selector when enforcement is off', () => {
    render(<OnlineLobby game={makeGame({ isHost: false, enforcedDiceMode: null })} />);
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
    const mockGame = {
      joinRoom: vi.fn(),
    };
    render(<OnlineLobby game={mockGame} />);
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
    const mockGame = {
      joinRoom: vi.fn(),
    };
    render(<OnlineLobby game={mockGame} />);
    
    const recentBtn = screen.getByText(/ROOM123/).closest('button')!;
    fireEvent.click(recentBtn);

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
    const mockGame = {
      joinRoom: vi.fn().mockResolvedValue({}),
    };
    render(<OnlineLobby game={mockGame as unknown as GameStore} />);
    
    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder') as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder') as HTMLInputElement;
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    fireEvent.change(roomInput, { target: { value: 'ROOM123' } });
    fireEvent.change(nameInput, { target: { value: 'Bob2' } });
    
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
    
    const mockGame = {
      joinRoom: vi.fn().mockResolvedValue({}),
    };
    render(<OnlineLobby game={mockGame as unknown as GameStore} />);
    
    const roomInput = screen.getByPlaceholderText('lobby.online.roomCodePlaceholder') as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText('lobby.online.yourNamePlaceholder') as HTMLInputElement;
    const joinBtn = screen.getByText('lobby.online.joinCreateButton');

    fireEvent.change(roomInput, { target: { value: 'ROOM_NEW' } });
    fireEvent.change(nameInput, { target: { value: 'Bob' } });
    
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
    const mockGame = { joinRoom: vi.fn() };
    render(<OnlineLobby game={mockGame as unknown as GameStore} />);
    expect(screen.queryByText('lobby.online.recentRooms')).not.toBeInTheDocument();
  });
});
