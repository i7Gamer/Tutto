import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import Statistics from './Statistics';

describe('Statistics Component', () => {
  beforeAll(() => {
    class MockIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.IntersectionObserver = MockIntersectionObserver;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    global.fetch = vi.fn(() => new Promise(() => {})); // Never resolves
    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    expect(screen.getByText('statistics.loading')).toBeInTheDocument();
  });

  it('fetches and displays personal and global statistics', async () => {
    const mockPersonalStats = {
      gamesPlayed: 10,
      wins: 6,
      totalPlaytime: 3600, // 1 hour
      totalTurns: 100,
      busts: 20,
      highestScore: 7000,
      totalScore: 40000,
      
      timesKleeblattReceived: 2,
      timesKleeblattCompleted: 1,
      timesKleeblattFailed: 1,
      
      timesKniffelReceived: 3,
      timesKniffelCompleted: 2,
      timesKniffelFailed: 1,
      
      timesPlusMinusReceived: 5,
      timesPlusMinusCompleted: 3,
      timesPlusMinusFailed: 2,
      
      timesFeuerwerkReceived: 4,
      feuerwerkPointsScored: 2000,
      feuerwerkBusts: 1,
      
      timesx2Received: 4,
      x2PointsScored: 3000,
      x2Busts: 2,
      
      timesSkipped: 5,
      times1000PointsDeducted: 1
    };

    const mockGlobalStats = {
      totalGamesPlayed: 100,
      totalPlaytime: 360000,
      totalTurns: 1000,
      totalScore: 400000
    };

    global.fetch = vi.fn((url) => {
      if (url.includes('global')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockGlobalStats)
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockPersonalStats)
      });
    });

    const onBackMock = vi.fn();
    render(<Statistics deviceId="test-device" onBack={onBackMock} />);

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText('statistics.loading')).toBeNull();
    });

    // Check Personal Stats Tab
    expect(screen.getByText('statistics.gamesPlayed')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument(); // Games played value
    expect(screen.getByText('60%')).toBeInTheDocument(); // Win rate
    
    // Check personal averages
    expect(screen.getByText('statistics.avgPointsPerTurn')).toBeInTheDocument();
    expect(screen.getByText('400')).toBeInTheDocument(); // 40000 / 100

    // Switch to Global Tab
    const globalTabButton = screen.getByRole('tab', { name: /statistics\.globalCommunity/i });
    fireEvent.click(globalTabButton);

    // Check Global Stats Tab
    await waitFor(() => {
      expect(screen.getByText('100')).toBeInTheDocument(); // Global Games played
    });
    
    // Click Back
    const backButton = screen.getByRole('button', { name: 'common.back' });
    fireEvent.click(backButton);
    expect(onBackMock).toHaveBeenCalled();
  });

  it('rounds win rate and bust rate to whole percentages with non-integer inputs', async () => {
    const mockPersonalStats = {
      gamesPlayed: 3,
      wins: 2,          // 2/3*100 = 66.67 → toFixed(0) → '67%'
      totalPlaytime: 3601, // avg: 3601/3 = 1200.33s → formatTime floors → '20:00'
      totalTurns: 30,
      busts: 7,         // bust rate: 7/30*100 = 23.33 → toFixed(0) → '23%'
      totalScore: 1500,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? {} : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('23%')).toBeInTheDocument();
    expect(screen.getByText('20:00')).toBeInTheDocument();
    // Old format with one decimal should not appear
    expect(screen.queryByText('66.7%')).not.toBeInTheDocument();
    expect(screen.queryByText('23.3%')).not.toBeInTheDocument();
  });

  it('rounds avg busts per game to nearest integer rather than one decimal', async () => {
    const mockPersonalStats = {
      gamesPlayed: 3,
      wins: 0,
      totalPlaytime: 0,
      totalTurns: 0,
      busts: 7,  // 7/3 = 2.33 → Math.round → 2 (toFixed(1) would give '2.3')
      totalScore: 0,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? {} : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.queryByText('2.3')).not.toBeInTheDocument();
  });

  it('handles fetch errors gracefully', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("Network error")));
    
    // Spy on console.error to avoid messy output in tests
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText('statistics.loading')).toBeNull();
    });

    // It should render empty states or zeros
    expect(screen.getByText('statistics.noPersonalGames')).toBeInTheDocument();
    
    expect(screen.getByText('statistics.noPersonalGames')).toBeInTheDocument();
    
    consoleSpy.mockRestore();
  });

  it('renders currentWinStreak and bestWinStreak correctly', async () => {
    const mockPersonalStats = {
      gamesPlayed: 10,
      wins: 6,
      currentWinStreak: 3,
      bestWinStreak: 5,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? {} : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getByText('🔥 3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('statistics.currentWinStreak')).toBeInTheDocument();
    expect(screen.getByText('statistics.bestWinStreak')).toBeInTheDocument();
  });

  it('renders the new players/rounds/feuerwerk/x2 tiles with correct values and averages', async () => {
    const mockPersonalStats = {
      gamesPlayed: 4,
      wins: 2,
      totalPlayersSum: 12,
      mostPlayersInGame: 5,
      totalRoundsSum: 40,
      longestGameRounds: 15,
      highestFeuerwerkTurnScore: 700,
      highestX2TurnScore: 900,
    };
    const mockGlobalStats = {
      totalGamesPlayed: 10,
      totalPlaytime: 1000,
      totalPlayersSum: 30,
      mostPlayersInGame: 6,
      totalRoundsSum: 90,
      longestGameRounds: 20,
      highestFeuerwerkTurnScore: 700,
      highestX2TurnScore: 1200,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getByText('statistics.mostPlayersInGame')).toBeInTheDocument();
    expect(screen.getAllByText('5').length).toBeGreaterThan(0); // personal mostPlayersInGame
    expect(screen.getByText('3')).toBeInTheDocument(); // personal avgPlayersPerGame: 12/4
    expect(screen.getByText('statistics.longestGameRounds')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument(); // personal avgRoundsPerGame: 40/4
    expect(screen.getByText('statistics.highestFeuerwerkTurn')).toBeInTheDocument();
    expect(screen.getByText('700')).toBeInTheDocument();
    expect(screen.getByText('statistics.highestX2Turn')).toBeInTheDocument();
    expect(screen.getByText('900')).toBeInTheDocument();

    // personal highestFeuerwerkTurnScore (700) ties the global max (700) — record badge shown.
    expect(screen.getByText(/statistics\.globalRecord/)).toBeInTheDocument();
  });

  it('does not show a record badge when personal and global values differ or are both zero', async () => {
    const mockPersonalStats = {
      gamesPlayed: 1,
      wins: 0,
      highestTurnScore: 500,
      highestFeuerwerkTurnScore: 0,
      highestX2TurnScore: 0,
      longestGameRounds: 0,
    };
    const mockGlobalStats = {
      totalGamesPlayed: 5,
      totalPlaytime: 500,
      highestTurnScore: 900,
      highestFeuerwerkTurnScore: 0,
      highestX2TurnScore: 0,
      longestGameRounds: 0,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.queryByText(/statistics\.globalRecord/)).not.toBeInTheDocument();
  });

  it('shows a green "better than global avg" badge when personal bust rate is lower than global', async () => {
    const mockPersonalStats = {
      gamesPlayed: 5,
      wins: 3,
      totalTurns: 100,
      busts: 5, // 5% bust rate
      totalScore: 10000,
    };
    const mockGlobalStats = {
      totalGamesPlayed: 50,
      totalPlaytime: 5000,
      totalTurns: 1000,
      totalBusts: 100, // 10% bust rate — personal is better (lower)
      totalScore: 90000,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    // (5-10)/10 * 100 = -50% -> 50% better (lower bust rate is better)
    const betterBadge = screen.getByText(/50% statistics\.betterThanGlobalAvg/);
    expect(betterBadge).toBeInTheDocument();
    expect(betterBadge).toHaveClass('text-green-500');
  });

  it('shows a red "worse than global avg" badge when personal avg points/turn is lower than global', async () => {
    const mockPersonalStats = {
      gamesPlayed: 5,
      wins: 3,
      totalTurns: 100,
      totalScore: 40000, // avg 400/turn
    };
    const mockGlobalStats = {
      totalGamesPlayed: 50,
      totalPlaytime: 5000,
      totalTurns: 1000,
      totalScore: 500000, // avg 500/turn — personal is worse (lower)
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    // (400-500)/500 * 100 = -20% -> 20% worse (lower avg points/turn is worse)
    const worseBadge = screen.getByText(/20% statistics\.worseThanGlobalAvg/);
    expect(worseBadge).toBeInTheDocument();
    expect(worseBadge).toHaveClass('text-red-500');
  });

  it('hides the comparison badge when there is no global baseline yet', async () => {
    const mockPersonalStats = {
      gamesPlayed: 5,
      wins: 3,
      totalTurns: 100,
      busts: 5,
      totalScore: 10000,
    };
    const mockGlobalStats = {}; // no games recorded globally yet

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.queryByText(/statistics\.betterThanGlobalAvg/)).not.toBeInTheDocument();
    expect(screen.queryByText(/statistics\.worseThanGlobalAvg/)).not.toBeInTheDocument();
  });

  it('renders currentWinStreak without fire icon if < 3', async () => {
    const mockPersonalStats = {
      gamesPlayed: 10,
      wins: 6,
      currentWinStreak: 2,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? {} : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.queryByText('🔥 2')).not.toBeInTheDocument();
  });
});
