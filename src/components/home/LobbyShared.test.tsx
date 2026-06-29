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

    expect(mockSetWinningScore).toHaveBeenCalledWith(0);
  });

  it('clamps winningScore to 99999 when value exceeds the upper bound', () => {
    const mockSetWinningScore = vi.fn();
    const game = {
      winningScore: 6000,
      setWinningScore: mockSetWinningScore,
      initialCards: {}
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={false} />);

    fireEvent.change(screen.getByDisplayValue('6000'), { target: { value: '200000' } });
    expect(mockSetWinningScore).toHaveBeenCalledWith(99999);
  });

  it('clamps turnDuration to 600 when value exceeds the upper bound', () => {
    const mockSetTurnDuration = vi.fn();
    const game = {
      winningScore: 6000,
      setWinningScore: vi.fn(),
      turnDuration: 120,
      setTurnDuration: mockSetTurnDuration,
      reconnectTimeout: 60,
      setReconnectTimeout: vi.fn(),
      initialCards: {}
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={true} />);

    fireEvent.change(screen.getByDisplayValue('120'), { target: { value: '800' } });
    expect(mockSetTurnDuration).toHaveBeenCalledWith(600);
  });

  it('clamps reconnectTimeout to 3600 when value exceeds the upper bound', () => {
    const mockSetReconnectTimeout = vi.fn();
    const game = {
      winningScore: 6000,
      setWinningScore: vi.fn(),
      turnDuration: 120,
      setTurnDuration: vi.fn(),
      reconnectTimeout: 60,
      setReconnectTimeout: mockSetReconnectTimeout,
      initialCards: {}
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={true} />);

    fireEvent.change(screen.getByDisplayValue('60'), { target: { value: '5000' } });
    expect(mockSetReconnectTimeout).toHaveBeenCalledWith(3600);
  });

  it('calls onResetGeneralSettings when reset button is clicked', () => {
    const mockResetGeneralSettings = vi.fn();
    const game = {
      winningScore: 5000,
      setWinningScore: vi.fn(),
      randomOrder: false,
      setRandomOrder: vi.fn(),
      turnDuration: 300,
      setTurnDuration: vi.fn(),
      reconnectTimeout: 120,
      setReconnectTimeout: vi.fn(),
      initialCards: {}
    };

    render(
      <AdvancedOptionsPanel
        showAdvanced={true}
        game={game}
        isOnline={true}
        onResetGeneralSettings={mockResetGeneralSettings}
        onResetCards={vi.fn()}
      />
    );

    const resetButtons = screen.getAllByRole('button').filter(btn =>
      btn.querySelector('svg[class*="RotateCcw"]') || false ||
      btn.title === 'Reset general settings to defaults'
    );
    expect(resetButtons.length).toBeGreaterThan(0);
    fireEvent.click(resetButtons[0]);
    expect(mockResetGeneralSettings).toHaveBeenCalledOnce();
  });

  it('calls onResetCards when reset cards button is clicked', () => {
    const mockResetCards = vi.fn();
    const game = {
      winningScore: 6000,
      setWinningScore: vi.fn(),
      randomOrder: true,
      setRandomOrder: vi.fn(),
      initialCards: { Kleeblatt: 5, Stop: 20 },
      setInitialCards: vi.fn()
    };

    render(
      <AdvancedOptionsPanel
        showAdvanced={true}
        game={game}
        isOnline={false}
        onResetGeneralSettings={vi.fn()}
        onResetCards={mockResetCards}
      />
    );

    const resetButtons = screen.getAllByRole('button').filter(btn =>
      btn.title === 'Reset cards to default values'
    );
    expect(resetButtons.length).toBeGreaterThan(0);
    fireEvent.click(resetButtons[0]);
    expect(mockResetCards).toHaveBeenCalledOnce();
  });

  it('hides reset buttons when callbacks are not provided', () => {
    const game = {
      winningScore: 6000,
      setWinningScore: vi.fn(),
      randomOrder: true,
      setRandomOrder: vi.fn(),
      initialCards: {}
    };

    render(<AdvancedOptionsPanel showAdvanced={true} game={game} isOnline={false} />);

    expect(screen.queryByTitle('Reset general settings to defaults')).toBeNull();
    expect(screen.queryByTitle('Reset cards to default values')).toBeNull();
  });
});
