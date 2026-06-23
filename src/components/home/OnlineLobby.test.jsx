import React from 'react';
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
