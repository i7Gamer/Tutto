import { render, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EndScreen, {
  STATS_FETCH_MAX_RETRIES, STATS_FETCH_RETRY_DELAY_MS, STATS_FETCH_INITIAL_DELAY_MS,
} from './EndScreen';
import { useGameStore } from '../store/useGameStore';

// Capture the chart's `data` prop instead of rendering a real canvas.
const chartCapture = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('react-chartjs-2', () => ({
  Line: (props: { data: unknown }) => {
    chartCapture.data = props.data;
    return null;
  },
}));

vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

interface ChartDataset { label: string; data: number[]; borderColor: string; backgroundColor: string }

describe('EndScreen Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000, position: 1 },
        { name: 'Bob', score: 5000, position: 2 }
      ],
      sortedPlayers: [
        { name: 'Alice', score: 10000, position: 1 },
        { name: 'Bob', score: 5000, position: 2 }
      ],
      round: 10,
      winningScore: 6000
    });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ isOnline: false, isHost: false, myName: null, preGameStats: null });
    vi.useRealTimers();
  });

  it('fires confetti once on mount when the winner screen shows', async () => {
    const confetti = await import('canvas-confetti').then(m => m.default);
    vi.clearAllMocks();

    render(<EndScreen />);

    expect(confetti).toHaveBeenCalledTimes(1);
  });

  it('renders flex div structure instead of table to avoid transform bugs', () => {
    const { container } = render(<EndScreen />);
    
    // Ensure there is no table element, only divs
    expect(container.querySelector('table')).toBeNull();
    
    // Ensure 'Game Statistics' title is rendered
    expect(container.textContent).toContain('end.gameStats');
  });

  it('reflects updated scores when the same number of players push a late gameState packet', () => {
    const { getByText } = render(<EndScreen />);

    // Initially, Alice is the winner (score 10000 > 5000)
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Simulate a late gameState packet arriving with updated scores (same player count)
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 15000, position: 1 }
        ]
      });
    });

    // Now Bob has the highest score — late update should be reflected
    expect(getByText('end.winner Bob')).toBeInTheDocument();
  });

  it('keeps the original winner when a player leaves the room after game-over', () => {
    const { getByText, queryByText } = render(<EndScreen />);

    // Initially, Alice is the winner (score 10000 > 5000)
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Simulate Alice leaving the room: players array shrinks
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Bob', score: 5000, position: 2 }
        ]
      });
    });

    // Bob should NOT become winner — the snapshot is frozen at max player count
    expect(getByText('end.winner Alice')).toBeInTheDocument();
    expect(queryByText('end.winner Bob')).toBeNull();
  });

  it('assigns correct position values to sorted players', () => {
    useGameStore.setState({
      players: [
        { name: 'Charlie', score: 3000 },
        { name: 'Alice', score: 10000 },
        { name: 'Bob', score: 5000 }
      ]
    });
    const { getByText } = render(<EndScreen />);
    
    // The EndScreen component should render the positions based on sorting by score
    expect(getByText('1.')).toBeInTheDocument();
    expect(getByText('2.')).toBeInTheDocument();
    expect(getByText('3.')).toBeInTheDocument();
  });

  it('assigns tied positions when players have equal scores', () => {
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000 },
        { name: 'Bob', score: 10000 },
        { name: 'Charlie', score: 5000 }
      ]
    });
    const { getAllByText, queryByText } = render(<EndScreen />);

    expect(getAllByText('1.')).toHaveLength(2);
    expect(queryByText('2.')).toBeNull();
    expect(queryByText('3.')).toBeInTheDocument();
  });

  it('does not render chart section when chartLabels is empty', () => {
    useGameStore.setState({ chartLabels: [] });
    const { container } = render(<EndScreen />);
    // Since we don't have a specific test ID, we can check if a canvas element exists (the chart uses canvas)
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('binds chart lines to player identity (name + color), not chartNames order or the positional palette', () => {
    // Reproduce the online desync: chartNames is in a stale/shuffled order, while
    // the authoritative players array (and chartValues, which is filled in the same
    // order) is the source of truth. Each line must follow players[i]/chartValues[i].
    chartCapture.data = null;
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000, position: 1, color: '#abc123' },
        { name: 'Bob', score: 5000, position: 2, color: '#def456' },
      ],
      chartValues: [[3000, 10000], [2000, 5000]],
      chartNames: ['Bob', 'Alice'], // drifted order — must be ignored for rendering
      chartLabels: [1, 2],
      round: 2,
    });

    render(<EndScreen theme="light" deviceId="" />);

    const datasets = (chartCapture.data as { datasets: ChartDataset[] }).datasets;

    // Line 0 owns chartValues[0] → it is Alice, in Alice's color (not chartNames[0]='Bob', not palette).
    expect(datasets[0].label).toBe('Alice');
    expect(datasets[0].data).toEqual([3000, 10000]);
    expect(datasets[0].borderColor).toBe('#abc123');

    // Line 1 owns chartValues[1] → it is Bob, in Bob's color.
    expect(datasets[1].label).toBe('Bob');
    expect(datasets[1].data).toEqual([2000, 5000]);
    expect(datasets[1].borderColor).toBe('#def456');
  });

  it('maintains snapshot when players array shrinks multiple times', () => {
    const { getByText } = render(<EndScreen />);

    // Initially: Alice (10k) > Bob (5k)
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // First shrink: remove Bob
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', score: 10000, position: 1 }
        ]
      });
    });

    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Even if re-render happens, snapshot should be frozen (no player data changes)
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', score: 10000, position: 1 }
        ]
      });
    });

    expect(getByText('end.winner Alice')).toBeInTheDocument();
  });

  it('uses snapshot for rankings even when new higher-scored player arrives', () => {
    const { getByText, queryByText } = render(<EndScreen />);

    // Snapshot frozen: Alice (10k) wins
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Player count increases with a new player who has higher score
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 5000, position: 2 },
          { name: 'Charlie', score: 20000, position: 1 }
        ]
      });
    });

    // Snapshot updates (3 > 2), so Charlie becomes winner
    expect(getByText('end.winner Charlie')).toBeInTheDocument();
    expect(queryByText('end.winner Alice')).toBeNull();
  });

  it('updates snapshot only when players array grows (high-water mark)', () => {
    const { getByText } = render(<EndScreen />);

    // Initial: Alice (10k), Bob (5k) - Alice is winner
    expect(getByText('end.winner Alice')).toBeInTheDocument();

    // Add Charlie with higher score
    act(() => {
      useGameStore.setState({
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 5000, position: 2 },
          { name: 'Charlie', score: 20000, position: 1 }
        ]
      });
    });

    // Snapshot should update (3 players > 2 players)
    // New winner should be Charlie
    expect(getByText('end.winner Charlie')).toBeInTheDocument();
  });

  describe('Play Again disconnected-player guard', () => {

    it('disables Play Again with the waiting message while an online player is disconnected (same rule as the lobby)', () => {
      useGameStore.setState({
        isOnline: true,
        isHost: true,
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 5000, position: 2, disconnected: true },
        ],
      });
      const { getByText, queryByText } = render(<EndScreen />);

      const btn = getByText('lobby.waitingForPlayersToReconnect').closest('button');
      expect(btn).toBeDisabled();
      expect(queryByText('end.playAgain')).toBeNull();
    });

    it('re-enables Play Again once every online player is connected again', () => {
      useGameStore.setState({
        isOnline: true,
        isHost: true,
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 5000, position: 2, disconnected: true },
        ],
      });
      const { getByText } = render(<EndScreen />);
      expect(getByText('lobby.waitingForPlayersToReconnect').closest('button')).toBeDisabled();

      act(() => {
        useGameStore.setState({
          players: [
            { name: 'Alice', score: 10000, position: 1 },
            { name: 'Bob', score: 5000, position: 2, disconnected: false },
          ],
        });
      });

      expect(getByText('end.playAgain').closest('button')).toBeEnabled();
    });

    it('never disables Play Again for local games', () => {
      useGameStore.setState({ isOnline: false });
      const { getByText } = render(<EndScreen />);
      expect(getByText('end.playAgain').closest('button')).toBeEnabled();
    });
  });

  describe('device stats fetching', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not fetch device stats for local games', () => {
      global.fetch = vi.fn();
      useGameStore.setState({ isOnline: false });

      render(<EndScreen deviceId="device-local-1" />);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not render the lifetime stats block for local games', () => {
      useGameStore.setState({ isOnline: false });
      const { queryByText } = render(<EndScreen deviceId="device-local-2" />);

      expect(queryByText('end.lifetimeStats')).not.toBeInTheDocument();
    });

    it('still fetches device stats for online games', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 3, wins: 1, pointsDeducted: 0, kniffelCompleted: 2 }),
      }));
      useGameStore.setState({ isOnline: true });

      render(<EndScreen deviceId="device-online-1" />);

      // The effect debounces the first fetch by 500ms; flush microtasks after
      // so the fetch/json chain (real Promises, unaffected by fake timers)
      // resolves within this act() boundary.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/stats/device-online-1?mode=normalized');
      vi.useRealTimers();
    });

    it('reads the custom bucket after a custom game, not the player\'s normal record', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 3, wins: 1, pointsDeducted: 0, kniffelCompleted: 2 }),
      }));
      useGameStore.setState({ isOnline: true, winningScore: 1000 });

      render(<EndScreen deviceId="device-online-2" />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/stats/device-online-2?mode=custom');
      vi.useRealTimers();
    });
  });

  describe('chart data/options memoization', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keeps the same chart data/options object references across an unrelated re-render', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 3, wins: 1, pointsDeducted: 0, kniffelCompleted: 2 }),
      }));
      useGameStore.setState({
        isOnline: true,
        round: 5,
        chartLabels: ['R1', 'R2'],
        chartValues: [[100, 200]],
        chartNames: ['Alice'],
      });

      render(<EndScreen deviceId="device-online-memo" />);
      const firstData = chartCapture.data;
      expect(firstData).not.toBeNull();

      // deviceStats arriving triggers an internal setState/re-render that has
      // nothing to do with the chart's own inputs (chartLabels/chartValues/
      // chartNames/players) — the chart data object should not be rebuilt.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(chartCapture.data).toBe(firstData);
      vi.useRealTimers();
    });
  });

  describe('personal-best records panel', () => {
    const setupOnlineGame = (overrides: Record<string, unknown> = {}) => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        ...overrides,
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not render the panel when there is no pre-game snapshot', () => {
      setupOnlineGame({ preGameStats: null });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newRecordsTitle')).not.toBeInTheDocument();
    });

    it('does not render the panel when nothing improved on the pre-game snapshot', () => {
      setupOnlineGame({
        preGameStats: { highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newRecordsTitle')).not.toBeInTheDocument();
    });

    it('shows a new personal best turn score when it exceeds the pre-game snapshot', () => {
      setupOnlineGame({
        // fastestWinTurns: 8 equals this game's totalTurns (8) — not an
        // improvement — isolating the assertion to the high-score record only.
        preGameStats: { highestTurnScore: 1000, fastestWinTurns: 8, fastestLossTurns: null },
      });
      const { getByText, queryByText } = render(<EndScreen deviceId="d1" />);
      expect(getByText('end.newRecordsTitle')).toBeInTheDocument();
      expect(getByText('end.newPersonalBestTurnScore')).toBeInTheDocument();
      expect(queryByText('end.newFastestWin')).not.toBeInTheDocument();
    });

    it('shows a new fastest win only for the actual winner', () => {
      setupOnlineGame({
        preGameStats: { highestTurnScore: 1500, fastestWinTurns: 10, fastestLossTurns: null },
      });
      const { getByText, queryByText } = render(<EndScreen deviceId="d1" />);
      expect(getByText('end.newFastestWin')).toBeInTheDocument();
      expect(queryByText('end.newFastestLoss')).not.toBeInTheDocument();
    });

    it('shows a new fastest loss for the losing player, not the winner', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Bob',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: { highestTurnScore: 800, fastestWinTurns: null, fastestLossTurns: 20 },
      });
      const { getByText, queryByText } = render(<EndScreen deviceId="d1" />);
      expect(getByText('end.newFastestLoss')).toBeInTheDocument();
      expect(queryByText('end.newFastestWin')).not.toBeInTheDocument();
      expect(queryByText('end.newPersonalBestTurnScore')).not.toBeInTheDocument();
    });

    it('does NOT flag a record when this game merely ties an earlier record (regression: post-merge equality is not enough)', () => {
      // The bug this guards against: comparing this game's value to the
      // POST-merge deviceStats (which already includes this game) would make
      // a mere tie look identical to a genuine new record. The fix compares
      // against the PRE-game snapshot instead, so a tie must not trigger it.
      setupOnlineGame({
        preGameStats: { highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newPersonalBestTurnScore')).not.toBeInTheDocument();
      expect(queryByText('end.newFastestWin')).not.toBeInTheDocument();
    });

    it('shows a new highest Feuerwerk/x2 turn record when this game exceeds the pre-game snapshot', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500, highestFeuerwerkTurnScore: 700, highestX2TurnScore: 900 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: { highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null, highestFeuerwerkTurnScore: 500, highestX2TurnScore: 600 },
      });
      const { getByText } = render(<EndScreen deviceId="d1" />);
      expect(getByText('end.newHighestFeuerwerk')).toBeInTheDocument();
      expect(getByText('end.newHighestX2')).toBeInTheDocument();
    });

    it('does not flag a new Feuerwerk/x2 record when this game merely ties the pre-game snapshot', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500, highestFeuerwerkTurnScore: 500, highestX2TurnScore: 600 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: { highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null, highestFeuerwerkTurnScore: 500, highestX2TurnScore: 600 },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newHighestFeuerwerk')).not.toBeInTheDocument();
      expect(queryByText('end.newHighestX2')).not.toBeInTheDocument();
    });
  });

  describe('win streak tiles', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('renders current and best win streak from device stats', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          gamesPlayed: 5, wins: 3, pointsDeducted: 0, kniffelCompleted: 7,
          currentWinStreak: 2, bestWinStreak: 4,
        }),
      }));
      useGameStore.setState({ isOnline: true });

      const { getByText } = render(<EndScreen deviceId="device-streak-1" />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      const currentStreakLabel = getByText('end.currentWinStreak');
      const bestStreakLabel = getByText('end.bestWinStreak');
      expect(currentStreakLabel.previousElementSibling?.textContent).toBe('2');
      expect(bestStreakLabel.previousElementSibling?.textContent).toBe('4');
      vi.useRealTimers();
    });

    it('cancels the pending stats retry when unmounted mid-retry', async () => {
      const originalFetch = global.fetch;
      // Force the retry path: the server-side stats write for this game
      // hasn't landed yet, so gamesPlayed comes back 0 and a retry is scheduled.
      const fetchMock = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 0 }),
      }));
      global.fetch = fetchMock as unknown as typeof fetch;
      useGameStore.setState({ isOnline: true });

      const { unmount } = render(<EndScreen deviceId="device-retry-unmount" />);

      // The initial delayed fetch fires and resolves — with gamesPlayed 0 the
      // next retry is now pending.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATS_FETCH_INITIAL_DELAY_MS);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      unmount();

      // Advance far past every possible retry: the unmount cleanup must have
      // cancelled the pending timer, so no further fetch may land.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATS_FETCH_RETRY_DELAY_MS * (STATS_FETCH_MAX_RETRIES + 2));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      global.fetch = originalFetch;
    });
  });
});
