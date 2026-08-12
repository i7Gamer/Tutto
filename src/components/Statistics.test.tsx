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

  // The ruleset and normal/custom rows used to be small grey-on-white pills,
  // visibly a different kind of control from the personal/global pair right
  // above them even though all three do the same job.
  describe('every tab row shares one selected/unselected treatment', () => {
    const renderTabs = async () => {
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 1, wins: 1, totalPlaytime: 100 }),
      }));
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
      return {
        top: screen.getByRole('tab', { name: /statistics\.personal/i }),
        ruleset: screen.getByRole('tab', { name: /lobby\.rulesetModernized/i }),
        mode: screen.getByRole('tab', { name: /statistics\.normalGames/i }),
      };
    };

    it('gives the selected sub-tabs the selected top-level tab\'s colours', async () => {
      const { top, ruleset, mode } = await renderTabs();

      for (const tab of [top, ruleset, mode]) {
        expect(tab).toHaveAttribute('aria-selected', 'true');
        expect(tab.className).toContain('bg-indigo-600');
        expect(tab.className).toContain('text-white');
        expect(tab.className).toContain('font-semibold');
      }
    });

    it('gives the unselected sub-tabs the unselected top-level tab\'s colours', async () => {
      await renderTabs();
      const unselected = [
        screen.getByRole('tab', { name: /statistics\.globalCommunity/i }),
        screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }),
        screen.getByRole('tab', { name: /statistics\.customGames/i }),
      ];

      for (const tab of unselected) {
        expect(tab).toHaveAttribute('aria-selected', 'false');
        expect(tab.className).toContain('text-gray-600');
        expect(tab.className).toContain('border-gray-200');
        // The old pills were text-sm; the sub-tabs now read at body size.
        expect(tab.className).not.toContain('text-sm');
      }
    });
  });

  it('never reports a negative number of lost cards globally', async () => {
    // The server counts completions and totals separately, so a crash between
    // the two writes can leave more completions than the total it derives the
    // losses from. The breakdown must floor at zero rather than print "-2 lost".
    const mockGlobalStats = {
      totalGamesPlayed: 5,
      totalPlaytime: 500,
      totalKniffel: 3,
      totalKniffelCompleted: 5,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : { gamesPlayed: 1, wins: 1, totalPlaytime: 100 }),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /statistics\.globalCommunity/i }));

    await waitFor(() => {
      expect(screen.getByText('statistics.cardBreakdown')).toBeInTheDocument();
    });
    expect(screen.queryByText('-2')).not.toBeInTheDocument();
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

    // A failed load is a failed load — not "you haven't played yet". The
    // empty state would misinform; the error panel says what happened.
    expect(screen.getByText('statistics.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText('statistics.noPersonalGames')).not.toBeInTheDocument();

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

  it('shows a record badge on all 5 eligible tiles when each personal value ties its own global counterpart', async () => {
    // Pins down that each tile compares against its OWN matching global field
    // (not some other field via a copy-paste mistake) by giving every one of
    // the 5 record-eligible stats a distinct tied value.
    const mockPersonalStats = {
      gamesPlayed: 1,
      wins: 1,
      highestTurnScore: 1000,
      fastestWinTurns: 5,
      longestGameRounds: 12,
      highestFeuerwerkTurnScore: 700,
      highestX2TurnScore: 900,
    };
    const mockGlobalStats = {
      totalGamesPlayed: 5,
      totalPlaytime: 500,
      highestTurnScore: 1000,
      fastestWinTurns: 5,
      longestGameRounds: 12,
      highestFeuerwerkTurnScore: 700,
      highestX2TurnScore: 900,
    };

    global.fetch = vi.fn((url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes('global') ? mockGlobalStats : mockPersonalStats),
    }));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getAllByText(/statistics\.globalRecord/)).toHaveLength(5);
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

  describe('switching the personal tab between normal and custom games', () => {
    // One row per mode, told apart by gamesPlayed so the rendered numbers say
    // which bucket is on screen.
    const serveByMode = (byMode: Record<string, Record<string, number> | undefined>) =>
      vi.fn((url: string) => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          url.includes('global')
            ? { totalGamesPlayed: 50, totalPlaytime: 1000, highestTurnScore: 3000, totalTurns: 100, totalScore: 40000 }
            : byMode[new URL(url, 'http://localhost').searchParams.get('mode') ?? 'normalized'] ?? {},
        ),
      }));

    const showCustom = async () => {
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.customGames/i }));
    };

    it('starts on the normal bucket', async () => {
      global.fetch = serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: { gamesPlayed: 77, wins: 70 } });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      expect(screen.getByText('11')).toBeInTheDocument();
      expect(screen.queryByText('77')).not.toBeInTheDocument();
    });

    it('shows the custom bucket once switched', async () => {
      global.fetch = serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: { gamesPlayed: 77, wins: 70 } });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      await showCustom();

      await waitFor(() => expect(screen.getByText('77')).toBeInTheDocument());
      expect(screen.queryByText('11')).not.toBeInTheDocument();
    });

    it('has its own empty state for a device that has played no custom game', async () => {
      global.fetch = serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: {} });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      await showCustom();

      await waitFor(() => expect(screen.getByText('statistics.noCustomGames')).toBeInTheDocument());
      expect(screen.queryByText('statistics.noPersonalGames')).not.toBeInTheDocument();
    });

    it('drops the global comparisons in the custom view, having nothing to compare against', async () => {
      // The global row holds no custom games at all, so "better than global
      // average" and "global record" would be measuring against a different
      // population entirely.
      global.fetch = serveByMode({
        normalized: { gamesPlayed: 5, wins: 1, totalTurns: 10, busts: 9, totalScore: 100, highestTurnScore: 3000 },
        custom: { gamesPlayed: 5, wins: 1, totalTurns: 10, busts: 9, totalScore: 100, highestTurnScore: 3000 },
      });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      // The normal view earns both badges against that global row…
      expect(screen.getByText(/statistics\.globalRecord/)).toBeInTheDocument();
      expect(screen.getByText(/statistics\.(better|worse)ThanGlobalAvg/)).toBeInTheDocument();

      await showCustom();

      await waitFor(() => expect(screen.queryByText(/statistics\.globalRecord/)).not.toBeInTheDocument());
      expect(screen.queryByText(/statistics\.(better|worse)ThanGlobalAvg/)).not.toBeInTheDocument();
    });

    it('leaves the global tab alone', async () => {
      global.fetch = serveByMode({ normalized: { gamesPlayed: 11 }, custom: { gamesPlayed: 77 } });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      await showCustom();
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.globalCommunity/i }));

      await waitFor(() => expect(screen.getByText('50')).toBeInTheDocument());
      expect(screen.queryByRole('tab', { name: /statistics\.customGames/i })).not.toBeInTheDocument();
    });
  });

  describe('switching between the modernized and classic rulesets', () => {
    // One row per bucket, told apart by gamesPlayed; the global handler also
    // records which ruleset it was asked for.
    const serveBuckets = () => {
      const requestedUrls: string[] = [];
      const fetchMock = vi.fn((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(
            url.includes('global')
              ? { totalGamesPlayed: 50, totalPlaytime: 1000, totalTuttos: 40, mostCardsInTurn: 4, highestForfeitedTurnScore: 2500 }
              : ({
                normalized: { gamesPlayed: 11, wins: 5, highestFeuerwerkTurnScore: 800 },
                classic: { gamesPlayed: 33, wins: 30, totalTuttos: 12, mostCardsInTurn: 3, highestForfeitedTurnScore: 1800 },
                classic_custom: { gamesPlayed: 44, wins: 40 },
              } as Record<string, Record<string, number>>)[new URL(url, 'http://localhost').searchParams.get('mode') ?? 'normalized'] ?? {},
          ),
        });
      });
      return { fetchMock, requestedUrls };
    };

    it('fetches the classic bucket and the classic global row once switched', async () => {
      const { fetchMock, requestedUrls } = serveBuckets();
      global.fetch = fetchMock;
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));

      await waitFor(() => expect(screen.getByText('33')).toBeInTheDocument());
      expect(screen.queryByText('11')).not.toBeInTheDocument();
      expect(requestedUrls.some(u => u.includes('mode=classic') && !u.includes('classic_custom'))).toBe(true);
      expect(requestedUrls.some(u => u.includes('ruleset=classic'))).toBe(true);
    });

    it('maps the custom tab to the classic_custom bucket under classic', async () => {
      const { fetchMock } = serveBuckets();
      global.fetch = fetchMock;
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.customGames/i }));

      await waitFor(() => expect(screen.getByText('44')).toBeInTheDocument());
    });

    it('swaps the per-card turn records for the chain records in the classic view', async () => {
      const { fetchMock } = serveBuckets();
      global.fetch = fetchMock;
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      // Modernized view shows the per-card records…
      expect(screen.getByText('statistics.highestFeuerwerkTurn')).toBeInTheDocument();
      expect(screen.queryByText('statistics.mostCardsInTurn')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));

      // …the classic view shows the chain records instead.
      await waitFor(() => expect(screen.getByText('statistics.mostCardsInTurn')).toBeInTheDocument());
      expect(screen.queryByText('statistics.highestFeuerwerkTurn')).not.toBeInTheDocument();
      expect(screen.getByText('statistics.totalTuttos')).toBeInTheDocument();
      expect(screen.getByText('statistics.highestForfeitedTurn')).toBeInTheDocument();
    });

    it('a failed bucket switch shows an error instead of the previous bucket\'s numbers', async () => {
      // The re-fetch keeps the old numbers on screen while the new ones load;
      // if the load FAILS those numbers would sit under the new tab's label
      // and read as that bucket's data.
      let failNext = false;
      global.fetch = vi.fn((url: string) => Promise.resolve(
        failNext
          ? { ok: false, status: 500, json: () => Promise.resolve({}) }
          : {
            ok: true,
            json: () => Promise.resolve(url.includes('global')
              ? { totalGamesPlayed: 50 }
              : { gamesPlayed: 11, wins: 5 }),
          },
      ));
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.getByText('11')).toBeInTheDocument());

      failNext = true;
      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));

      await waitFor(() => expect(screen.getByText('statistics.loadFailed')).toBeInTheDocument());
      expect(screen.queryByText('11')).not.toBeInTheDocument();

      // A later successful switch recovers.
      failNext = false;
      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetModernized/i }));
      await waitFor(() => expect(screen.getByText('11')).toBeInTheDocument());
      expect(screen.queryByText('statistics.loadFailed')).not.toBeInTheDocument();
    });

    it('shows a dash, not a zero, for classic records that do not exist yet', async () => {
      const { fetchMock } = serveBuckets();
      global.fetch = fetchMock;
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));
      // The classic_custom bucket has never recorded a chain — its records
      // are genuinely absent (NULL), which "0" would misread as data.
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.customGames/i }));
      await waitFor(() => expect(screen.getByText('44')).toBeInTheDocument());

      // Most Cards in a Turn + Biggest Turn Thrown Away; Total Tuttos is a
      // counter, where zero is the honest value.
      expect(screen.getAllByText('–')).toHaveLength(2);
    });

    it('shows the Feuerwerk/x2 breakdown rows as draw counts only under classic', async () => {
      const { fetchMock } = serveBuckets();
      global.fetch = fetchMock;
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      // Modernized: the two scoring-card rows carry busts and average points.
      expect(screen.getAllByText('statistics.avgPts')).toHaveLength(2);
      expect(screen.getAllByText('statistics.busts')).toHaveLength(2);

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));
      await waitFor(() => expect(screen.getByText('statistics.mostCardsInTurn')).toBeInTheDocument());

      // Classic never writes the per-card bust/points attribution (the engine
      // skips it across chains) — inventing "wins" and "0 avg points" from
      // the empty counters would misread as data. Draw counts only.
      expect(screen.queryByText('statistics.avgPts')).not.toBeInTheDocument();
      expect(screen.queryByText('statistics.busts')).not.toBeInTheDocument();
      // The genuinely tracked yes/no cards keep their win/lose split.
      expect(screen.getAllByText('statistics.won').length).toBeGreaterThan(0);

      // The global tab's breakdown follows the same rule.
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.globalCommunity/i }));
      await waitFor(() => expect(screen.getByText('statistics.totalGames')).toBeInTheDocument());
      expect(screen.queryByText('statistics.avgPts')).not.toBeInTheDocument();
      expect(screen.queryByText('statistics.busts')).not.toBeInTheDocument();
    });
  });

  describe('custom games on the global tab', () => {
    const showGlobalTab = async (globalStats: Record<string, number>) => {
      global.fetch = vi.fn((url) => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url.includes('global') ? globalStats : { gamesPlayed: 1, wins: 1, totalPlaytime: 100 }),
      }));
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.globalCommunity/i }));
      await waitFor(() => expect(screen.getByText('statistics.totalGames')).toBeInTheDocument());
    };

    it('says how many custom games were played but not counted', async () => {
      await showGlobalTab({ totalGamesPlayed: 20, totalPlaytime: 1000, customGamesPlayed: 7 });
      expect(screen.getByText('statistics.customGamesNotCounted')).toBeInTheDocument();
    });

    it('stays quiet when no custom game has ever been played', async () => {
      await showGlobalTab({ totalGamesPlayed: 20, totalPlaytime: 1000, customGamesPlayed: 0 });
      expect(screen.queryByText('statistics.customGamesNotCounted')).not.toBeInTheDocument();
    });

    it('stays quiet for a server that predates the counter', async () => {
      await showGlobalTab({ totalGamesPlayed: 20, totalPlaytime: 1000 });
      expect(screen.queryByText('statistics.customGamesNotCounted')).not.toBeInTheDocument();
    });
  });
});
