import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StartGameButton, PlayerList, AdvancedOptionsPanel } from './LobbyShared';

describe('StartGameButton', () => {
  it('renders "Start Game!" when not disabled and playersCount >= 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={2} disabled={false} />);
    expect(screen.getByText('lobby.startGame')).toBeInTheDocument();
  });

  it('renders "Need at least 2 players" when disabled and playersCount < 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={1} disabled={true} />);
    expect(screen.getByText('lobby.needAtLeast2Players')).toBeInTheDocument();
  });

  it('renders "Waiting for players to reconnect..." when disabled but playersCount >= 2', () => {
    render(<StartGameButton startGame={() => {}} playersCount={3} disabled={true} />);
    expect(screen.getByText('lobby.waitingForPlayersToReconnect')).toBeInTheDocument();
  });

  it('does not render when playersCount is 0', () => {
    const { container } = render(<StartGameButton startGame={() => {}} playersCount={0} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('PlayerList', () => {
  const mockPlayers = [
    { name: 'Alice', color: '#ff0000', socketId: 'host1' },
    { name: 'Bob', color: '#00ff00', socketId: 'client2' },
    { name: 'Charlie', color: '#0000ff', socketId: 'client3' }
  ];

  it('renders players and reorder buttons correctly for host', () => {
    const { container } = render(
      <PlayerList 
        players={mockPlayers} 
        reorderPlayers={() => {}} 
        isOnline={true} 
        isHost={true} 
        changeColor={() => {}} 
        onRemovePlayer={() => {}} 
      />
    );

    // Alice is the first player. She should only have a Down button (ChevronDown)
    // The up/down buttons are wrapped in a flex container `w-[68px]`
    const downButtons = container.querySelectorAll('.lucide-chevron-down');
    const upButtons = container.querySelectorAll('.lucide-chevron-up');

    // Since we now render all buttons to prevent focus shifting on mobile,
    // total up = 3, total down = 3
    expect(downButtons.length).toBe(3);
    expect(upButtons.length).toBe(3);
    
    // But the first Up button should be invisible
    expect(upButtons[0].closest('button').className).toContain('opacity-0');
    // And the last Down button should be invisible
    expect(downButtons[2].closest('button').className).toContain('opacity-0');
  });

  it('renders flex div structure instead of table to avoid transform bugs', () => {
    const { container } = render(
      <PlayerList 
        players={mockPlayers} 
        reorderPlayers={() => {}} 
        isOnline={false} 
        isHost={true} 
        changeColor={() => {}} 
        onRemovePlayer={() => {}} 
      />
    );

    // Ensure there is no table element, only divs
    expect(container.querySelector('table')).toBeNull();
    
    // Check that we have motion.div wrappers for the rows
    const rows = screen.getAllByText(/Alice|Bob|Charlie/);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('AdvancedOptionsPanel', () => {
  it('updates card count using object syntax instead of functional update', () => {
    const mockSetInitialCards = vi.fn();
    const game = {
      initialCards: { Kleeblatt: 1, Stop: 10 },
      setInitialCards: mockSetInitialCards
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={true} />);

    // Find the input for 'Kleeblatt'
    const input = screen.getByDisplayValue('1');
    fireEvent.change(input, { target: { value: '2' } });

    // It should be called with an object, not a function
    expect(mockSetInitialCards).toHaveBeenCalledWith({
      Kleeblatt: 2,
      Stop: 10
    });
  });
  it('prevents negative values for number inputs', () => {
    const mockSetWinningScore = vi.fn();
    const game = {
      winningScore: 50,
      setWinningScore: mockSetWinningScore,
      initialCards: {}
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={false} />);

    const input = screen.getByDisplayValue('50');
    fireEvent.change(input, { target: { value: '-10' } });

    // Should clamp -10 to 0
    expect(mockSetWinningScore).toHaveBeenCalledWith(0);
  });
});
