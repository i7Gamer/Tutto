import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OnlineLobby from './OnlineLobby';

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
