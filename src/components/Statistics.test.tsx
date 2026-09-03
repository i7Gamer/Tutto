import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import Statistics from './Statistics';
import { RECORD_FIELDS } from '../utils/statRecords';
import { mockFetchJson, nonNull } from '../testing/factories';

describe('Statistics Component', () => {
  beforeAll(() => {
    class MockIntersectionObserver implements IntersectionObserver {
      root: Element | Document | null = null;
      rootMargin = '';
      scrollMargin = '';
      thresholds: number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    window.IntersectionObserver = MockIntersectionObserver;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // vi.restoreAllMocks() restores SPIES; these suites assign global.fetch
  // directly, which it cannot undo. Left alone, the last fetch a test assigned
  // answers for every later test that forgets to assign its own — which passes,
  // for the wrong reason. Putting the shared stub back (setupTests.tsx, which
  // rejects anything it does not recognise) makes a forgotten assignment fail
  // loudly instead.
  const sharedFetchStub = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = sharedFetchStub;
  });


  it('renders loading state initially', () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})); // Never resolves
    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    expect(screen.getByText('statistics.loading')).toBeInTheDocument();
  });

  it('keeps the way back open while the statistics are still loading', () => {
    // A request that never settles (server down mid-fetch) used to leave the
    // spinner as the whole page, with a browser reload the only way out.
    global.fetch = vi.fn(() => new Promise<Response>(() => {})); // Never resolves
    const onBackMock = vi.fn();
    render(<Statistics deviceId="test-device" onBack={onBackMock} />);

    expect(screen.getByText('statistics.loading')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }));

    expect(onBackMock).toHaveBeenCalled();
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

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('global')) {
        return Promise.resolve(mockFetchJson(mockGlobalStats));
      }
      return Promise.resolve(mockFetchJson(mockPersonalStats));
    }));

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

  it('groups the card-breakdown counts and averages like every other number', async () => {
    // 1,200 Feuerwerk received, 200 busted -> 1,000 won; 2,400,000 points
    // over 1,200 cards -> 2,000 average. All four-digit or more, so a raw
    // render would show bare digits beside the grouped StatTiles above them.
    const personal = {
      gamesPlayed: 10, wins: 6, totalPlaytime: 100, totalTurns: 100, totalScore: 40000,
      feuerwerkReceived: 1200, feuerwerkBusts: 200, feuerwerkPointsScored: 2_400_000,
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? {} : personal))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getAllByText('1,200').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2,000').length).toBeGreaterThan(0);
  });

  it('names the device in a header rather than in the URL', async () => {
    // A path segment is written into every fronting proxy's access.log, and
    // this id is what lets a client reclaim its seat — see deviceStatsRequest.
    const fetchMock = vi.fn((url: string, _init?: unknown) => Promise.resolve(mockFetchJson(
      url.includes('global')
        ? { totalGamesPlayed: 1, totalPlaytime: 1 }
        : { gamesPlayed: 1, wins: 1, totalPlaytime: 100 },
    )));
    vi.stubGlobal('fetch', fetchMock);

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    const personalCall = fetchMock.mock.calls.find(([url]) => !url.includes('global'));
    expect(personalCall).toBeDefined();
    expect(nonNull(personalCall)[0]).not.toContain('test-device');
    expect(nonNull(personalCall)[1]).toEqual({ headers: { 'x-tutto-device': 'test-device' } });
  });

  // The ruleset and normal/custom rows used to be small grey-on-white pills,
  // visibly a different kind of control from the personal/global pair right
  // above them even though all three do the same job.
  describe('every tab row shares one selected/unselected treatment', () => {
    const renderTabs = async () => {
      global.fetch = vi.fn(() => Promise.resolve(mockFetchJson({ gamesPlayed: 1, wins: 1, totalPlaytime: 100 })));
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
        // C69.2: the sub-tabs now read at body size from `sm:` up (the old
        // fix this test pinned), but smaller below it — a `sm:text-base`
        // override is how a bare `text-sm` stays mobile-only.
        expect(tab.className).toContain('sm:text-base');
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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : { gamesPlayed: 1, wins: 1, totalPlaytime: 100 }))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? {} : mockPersonalStats))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('23%')).toBeInTheDocument();
    expect(screen.getByText('20:00')).toBeInTheDocument();
    // Old format with one decimal should not appear
    expect(screen.queryByText('66.7%')).not.toBeInTheDocument();
    expect(screen.queryByText('23.3%')).not.toBeInTheDocument();
  });

  // C67: Avg Busts/Game used to round to a whole number here while EndScreen's
  // own Avg Busts/Game tile showed one decimal for the very same kind of
  // average — the two screens disagreed about how precise the stat is.
  // Both now go through formatFixed(x, AVG_DECIMALS, lang), so this renders
  // the one-decimal form instead of Math.round's integer.
  it('renders avg busts per game to one decimal place, not rounded to an integer', async () => {
    const mockPersonalStats = {
      gamesPlayed: 3,
      wins: 0,
      totalPlaytime: 0,
      totalTurns: 0,
      busts: 7, // 7/3 = 2.33... -> "2.3" to one decimal; Math.round would give "2"
      totalScore: 0,
    };

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? {} : mockPersonalStats))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getByText('2.3')).toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? {} : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.getAllByText(/statistics\.globalRecord/)).toHaveLength(5);
  });

  it('badges the fastest loss when it ties the global record, like every other record tile', async () => {
    // fastestLossTurns is a RECORD_COLUMNS entry on the server (MIN), with its
    // own global column and its own migration -- the number IS collected and
    // IS compared across every device. The client's GlobalStats interface just
    // never declared it, so `g?.fastestLossTurns` was unreachable, the tile was
    // the one record-eligible stat rendered with no way to know it held the
    // record, and the global panel had no counterpart tile at all.
    const mockPersonalStats = { gamesPlayed: 1, wins: 0, fastestLossTurns: 4 };
    const mockGlobalStats = { totalGamesPlayed: 5, totalPlaytime: 500, fastestLossTurns: 4 };

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    const tile = screen.getByText('statistics.fastestLossTurns').parentElement;
    expect(within(nonNull(tile)).queryByText(/statistics\.globalRecord/)).toBeInTheDocument();
  });

  // Every MAX/MIN record field, driven from one table instead of one test per
  // tile — mostPlayersInGame and highestForfeitedTurnScore used to have no
  // badge at all (holdsRecord was simply never wired to them), while
  // mostCardsInTurn and fastestLossTurns right next to them did. A record
  // being a TIE (personal === global) is correct and unrelated to this bug —
  // see isRecordHolder's own doc comment — the bug was only ever which tiles
  // bothered to ask.
  // Label key (and, for the two chain-only records, the ruleset tab that
  // reveals the tile) for each entry in the component's own RECORD_FIELDS —
  // driving the field names from that shared list, rather than re-typing
  // them here, is what keeps this table from drifting out of sync with what
  // Statistics.tsx actually renders.
  const RECORD_TILES: Record<typeof RECORD_FIELDS[number], { labelKey: string; ruleset?: 'classic' }> = {
    highestTurnScore: { labelKey: 'statistics.highestTurn' },
    fastestWinTurns: { labelKey: 'statistics.fastestWinTurns' },
    fastestLossTurns: { labelKey: 'statistics.fastestLossTurns' },
    mostPlayersInGame: { labelKey: 'statistics.mostPlayersInGame' },
    longestGameRounds: { labelKey: 'statistics.longestGameRounds' },
    highestFeuerwerkTurnScore: { labelKey: 'statistics.highestFeuerwerkTurn' },
    highestX2TurnScore: { labelKey: 'statistics.highestX2Turn' },
    mostCardsInTurn: { labelKey: 'statistics.mostCardsInTurn', ruleset: 'classic' },
    highestForfeitedTurnScore: { labelKey: 'statistics.highestForfeitedTurn', ruleset: 'classic' },
  };
  const RECORD_TABLE = RECORD_FIELDS.map((field) => ({ field, ...RECORD_TILES[field] }));

  const renderWithStats = async (field: string, personalValue: number, globalValue: number, ruleset?: 'classic') => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global')
        ? { totalGamesPlayed: 5, totalPlaytime: 500, [field]: globalValue }
        : { gamesPlayed: 1, wins: 1, [field]: personalValue }))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    if (ruleset === 'classic') {
      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));
    }
  };

  describe('every record tile badges consistently (table-driven)', () => {
    it.each(RECORD_TABLE)('badges $field when the personal value ties the global one', async ({ field, labelKey, ruleset }) => {
      await renderWithStats(field, 7, 7, ruleset);

      await waitFor(() => expect(screen.getByText(labelKey)).toBeInTheDocument());
      const tile = screen.getByText(labelKey).parentElement;
      expect(within(nonNull(tile)).queryByText(/statistics\.globalRecord/)).toBeInTheDocument();
    });

    it.each(RECORD_TABLE)('does not badge $field when the personal value falls short of the global one', async ({ field, labelKey, ruleset }) => {
      await renderWithStats(field, 3, 7, ruleset);

      await waitFor(() => expect(screen.getByText(labelKey)).toBeInTheDocument());
      const tile = screen.getByText(labelKey).parentElement;
      expect(within(nonNull(tile)).queryByText(/statistics\.globalRecord/)).not.toBeInTheDocument();
    });
  });

  it('shows the global fastest loss beside the global fastest win', async () => {
    const mockGlobalStats = {
      totalGamesPlayed: 5, totalPlaytime: 500, fastestWinTurns: 6, fastestLossTurns: 4,
    };

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : { gamesPlayed: 1 }))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /statistics\.globalCommunity/i }));

    // Retried: the personal panel is still mid-exit for a tick after the click.
    await waitFor(() => {
      const tile = screen.getByText('statistics.fastestLossTurns').parentElement;
      expect(within(nonNull(tile)).queryByText('4'), 'the global minimum loss length has no tile').toBeInTheDocument();
    });
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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? mockGlobalStats : mockPersonalStats))));

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

    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? {} : mockPersonalStats))));

    render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

    expect(screen.queryByText('🔥 2')).not.toBeInTheDocument();
  });

  describe('switching the personal tab between normal and custom games', () => {
    // One row per mode, told apart by gamesPlayed so the rendered numbers say
    // which bucket is on screen.
    const serveByMode = (byMode: Record<string, Record<string, number> | undefined>) => {
      vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(
        url.includes('global')
          ? { totalGamesPlayed: 50, totalPlaytime: 1000, highestTurnScore: 3000, totalTurns: 100, totalScore: 40000 }
          : byMode[new URL(url, 'http://localhost').searchParams.get('mode') ?? 'normalized'] ?? {},
      ))));
    };

    const showCustom = async () => {
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.customGames/i }));
    };

    it('starts on the normal bucket', async () => {
      serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: { gamesPlayed: 77, wins: 70 } });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      expect(screen.getByText('11')).toBeInTheDocument();
      expect(screen.queryByText('77')).not.toBeInTheDocument();
    });

    it('shows the custom bucket once switched', async () => {
      serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: { gamesPlayed: 77, wins: 70 } });
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      await showCustom();

      await waitFor(() => expect(screen.getByText('77')).toBeInTheDocument());
      expect(screen.queryByText('11')).not.toBeInTheDocument();
    });

    it('has its own empty state for a device that has played no custom game', async () => {
      serveByMode({ normalized: { gamesPlayed: 11, wins: 5 }, custom: {} });
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
      serveByMode({
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
      serveByMode({ normalized: { gamesPlayed: 11 }, custom: { gamesPlayed: 77 } });
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
        return Promise.resolve(mockFetchJson(
          url.includes('global')
            ? { totalGamesPlayed: 50, totalPlaytime: 1000, totalTuttos: 40, mostCardsInTurn: 4, highestForfeitedTurnScore: 2500 }
            : ({
              normalized: { gamesPlayed: 11, wins: 5, highestFeuerwerkTurnScore: 800 },
              classic: { gamesPlayed: 33, wins: 30, totalTuttos: 12, mostCardsInTurn: 3, highestForfeitedTurnScore: 1800 },
              classic_custom: { gamesPlayed: 44, wins: 40 },
            } as Record<string, Record<string, number>>)[new URL(url, 'http://localhost').searchParams.get('mode') ?? 'normalized'] ?? {},
        ));
      });
      return { fetchMock, requestedUrls };
    };

    it('fetches the classic bucket and the classic global row once switched', async () => {
      const { fetchMock, requestedUrls } = serveBuckets();
      vi.stubGlobal('fetch', fetchMock);
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
      vi.stubGlobal('fetch', fetchMock);
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      fireEvent.click(screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }));
      fireEvent.click(screen.getByRole('tab', { name: /statistics\.customGames/i }));

      await waitFor(() => expect(screen.getByText('44')).toBeInTheDocument());
    });

    it('swaps the per-card turn records for the chain records in the classic view', async () => {
      const { fetchMock } = serveBuckets();
      vi.stubGlobal('fetch', fetchMock);
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
      vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
        failNext
          ? mockFetchJson({}, { ok: false, status: 500 })
          : mockFetchJson(url.includes('global')
            ? { totalGamesPlayed: 50 }
            : { gamesPlayed: 11, wins: 5 }),
      )));
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
      vi.stubGlobal('fetch', fetchMock);
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
      vi.stubGlobal('fetch', fetchMock);
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
      vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(mockFetchJson(url.includes('global') ? globalStats : { gamesPlayed: 1, wins: 1, totalPlaytime: 100 }))));
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

  describe('a fetch superseded while its body is still being parsed', () => {
    it('drops a stale personal response instead of pairing it with fresh global stats', async () => {
      // The staleness guard was read BEFORE the `await parseJsonObject(...)`
      // that sat inside the setter's own ARGUMENT, so a superseded fetch still
      // ran setPersonalStats; the next guard then aborted before setGlobalStats
      // — leaving the old bucket's personal numbers under the new bucket's
      // label, which also skews the holdsRecord comparison between them.
      // EndScreen.tsx and Game.tsx both re-check after their parse; this was
      // the one site that did not.
      let releaseStaleBody!: (v: unknown) => void;
      const staleBody = new Promise((resolve) => { releaseStaleBody = resolve; });
      // The device id rides the x-tutto-device HEADER, not the URL, so the two
      // personal requests are indistinguishable by url — order is what tells
      // them apart.
      let personalCalls = 0;

      global.fetch = vi.fn((url: string) => {
        if (url.includes('global')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ totalGamesPlayed: 100, totalPlaytime: 1000 }) });
        }
        personalCalls += 1;
        // The first personal body hangs in json(), not in fetch(): the request
        // itself resolves, so the effect gets past its first guard and parks
        // exactly where the bug lives.
        if (personalCalls === 1) {
          return Promise.resolve({ ok: true, json: () => staleBody });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ gamesPlayed: 42, wins: 21, totalPlaytime: 100, totalTurns: 100, totalScore: 40000 }),
        });
      }) as unknown as typeof fetch;

      const { rerender } = render(<Statistics deviceId="device-old" onBack={vi.fn()} />);
      // Let Promise.all settle so the effect is parked on the parse.
      await new Promise((r) => setTimeout(r, 0));

      // Supersede it: a new deviceId re-runs the effect, and its cleanup marks
      // the first one stale.
      rerender(<Statistics deviceId="device-new" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
      expect(screen.getByText('42')).toBeInTheDocument();

      // Now the stale body lands. It must be dropped entirely.
      releaseStaleBody({ gamesPlayed: 7, wins: 1, totalPlaytime: 1, totalTurns: 1, totalScore: 1 });
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.getByText('42'), 'the superseded response overwrote the current bucket').toBeInTheDocument();
      expect(screen.queryByText('7')).not.toBeInTheDocument();
    });
  });

  // C66 — useRovingTabs wires ArrowLeft/ArrowRight/Home/End into all three
  // tablists identically, so one representative tablist (the ruleset pair)
  // stands in for the mechanism and the others get a narrower check that
  // they are wired up at all.
  describe('roving tabs keyboard navigation', () => {
    const renderReady = async () => {
      global.fetch = vi.fn(() => Promise.resolve(mockFetchJson({ gamesPlayed: 1, wins: 1, totalPlaytime: 100 })));
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());
    };

    it('ArrowRight moves selection and focus to the next tab, wrapping past the end', async () => {
      await renderReady();
      const modernized = screen.getByRole('tab', { name: /lobby\.rulesetModernized/i });
      const classic = screen.getByRole('tab', { name: /lobby\.rulesetClassic/i });

      modernized.focus();
      fireEvent.keyDown(modernized, { key: 'ArrowRight' });
      expect(classic).toHaveAttribute('aria-selected', 'true');
      expect(classic).toHaveFocus();

      fireEvent.keyDown(classic, { key: 'ArrowRight' });
      expect(modernized).toHaveAttribute('aria-selected', 'true');
      expect(modernized).toHaveFocus();
    });

    it('ArrowLeft moves selection and focus to the previous tab, wrapping before the start', async () => {
      await renderReady();
      const modernized = screen.getByRole('tab', { name: /lobby\.rulesetModernized/i });
      const classic = screen.getByRole('tab', { name: /lobby\.rulesetClassic/i });

      modernized.focus();
      fireEvent.keyDown(modernized, { key: 'ArrowLeft' });
      expect(classic).toHaveAttribute('aria-selected', 'true');
      expect(classic).toHaveFocus();
    });

    it('Home and End jump to the first and last tab', async () => {
      await renderReady();
      const modernized = screen.getByRole('tab', { name: /lobby\.rulesetModernized/i });
      const classic = screen.getByRole('tab', { name: /lobby\.rulesetClassic/i });

      modernized.focus();
      fireEvent.keyDown(modernized, { key: 'End' });
      expect(classic).toHaveAttribute('aria-selected', 'true');
      expect(classic).toHaveFocus();

      fireEvent.keyDown(classic, { key: 'Home' });
      expect(modernized).toHaveAttribute('aria-selected', 'true');
      expect(modernized).toHaveFocus();
    });

    // Roving tabIndex: only the selected tab is a Tab stop, so keyboard users
    // don't tab through every pill to get past the group.
    it('gives only the selected tab in each tablist a 0 tabIndex', async () => {
      await renderReady();
      const selected = [
        screen.getByRole('tab', { name: /statistics\.personal/i }),
        screen.getByRole('tab', { name: /lobby\.rulesetModernized/i }),
        screen.getByRole('tab', { name: /statistics\.normalGames/i }),
      ];
      const unselected = [
        screen.getByRole('tab', { name: /statistics\.globalCommunity/i }),
        screen.getByRole('tab', { name: /lobby\.rulesetClassic/i }),
        screen.getByRole('tab', { name: /statistics\.customGames/i }),
      ];

      selected.forEach(tab => expect(tab).toHaveAttribute('tabindex', '0'));
      unselected.forEach(tab => expect(tab).toHaveAttribute('tabindex', '-1'));
    });

    it('moves the personal/global tablist selection with the arrow keys too', async () => {
      await renderReady();
      const personal = screen.getByRole('tab', { name: /statistics\.personal/i });
      const globalTab = screen.getByRole('tab', { name: /statistics\.globalCommunity/i });

      personal.focus();
      fireEvent.keyDown(personal, { key: 'ArrowRight' });
      expect(globalTab).toHaveAttribute('aria-selected', 'true');
      expect(globalTab).toHaveFocus();
    });

    it('moves the personal/custom mode tablist selection with the arrow keys too', async () => {
      await renderReady();
      const normal = screen.getByRole('tab', { name: /statistics\.normalGames/i });
      const custom = screen.getByRole('tab', { name: /statistics\.customGames/i });

      normal.focus();
      fireEvent.keyDown(normal, { key: 'ArrowRight' });
      expect(custom).toHaveAttribute('aria-selected', 'true');
      expect(custom).toHaveFocus();
    });
  });

  // Each tab gets an id its panel can point aria-labelledby at, and each
  // panel gets role="tabpanel" — without ids, aria-controls/aria-labelledby
  // would have nothing to reference.
  describe('tab/panel wiring', () => {
    it('gives every tab an id and every panel an aria-labelledby pointing back at it', async () => {
      global.fetch = vi.fn(() => Promise.resolve(mockFetchJson({ gamesPlayed: 1, wins: 1, totalPlaytime: 100 })));
      render(<Statistics deviceId="test-device" onBack={vi.fn()} />);
      await waitFor(() => expect(screen.queryByText('statistics.loading')).toBeNull());

      const personalTab = screen.getByRole('tab', { name: /statistics\.personal/i });
      expect(personalTab).toHaveAttribute('id');

      const panels = screen.getAllByRole('tabpanel');
      expect(panels.length).toBeGreaterThan(0);
      panels.forEach(panel => {
        const labelledBy = panel.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        expect(document.getElementById(labelledBy as string)).not.toBeNull();
      });
    });
  });
});
