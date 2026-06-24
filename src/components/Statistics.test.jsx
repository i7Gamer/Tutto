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
    expect(screen.getByText('60.0%')).toBeInTheDocument(); // Win rate
    
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
    
    consoleSpy.mockRestore();
  });
});
