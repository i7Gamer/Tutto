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

  // cleanup() FIRST, then the reset: a store write while EndScreen is still
  // mounted re-renders it outside act(). Every store field a nested describe
  // stages belongs here rather than in its own afterEach, which would run
  // before this one — i.e. before the unmount.
  afterEach(() => {
    cleanup();
    useGameStore.setState({
      isOnline: false, isHost: false, myName: null, preGameStats: null,
      ruleset: 'modernized',
    });
    vi.useRealTimers();
  });

  it('fires confetti once on mount when the winner screen shows', async () => {
    const confetti = await import('canvas-confetti').then(m => m.default);
    vi.clearAllMocks();

    render(<EndScreen />);

    expect(confetti).toHaveBeenCalledTimes(1);
  });

  it('wraps a long winner name instead of widening the page', () => {
    // A 30-character name (the allowed maximum) is one unbreakable word to
    // the layout. Without break-words the 5xl heading widened the mobile
    // viewport to ~836px and the browser zoomed the whole screen out; the
    // stats-table header cells (fixed w-32) bled the same name into the
    // neighbouring column.
    const longName = 'Maximilian-Alexander-Schmidt30';
    const players = [
      { name: longName, score: 10000, position: 1 },
      { name: 'Bob', score: 5000, position: 2 },
    ];
    useGameStore.setState({ players, sortedPlayers: players });

    const { getByText, getAllByText } = render(<EndScreen />);

    expect(getByText(`end.winner ${longName}`)).toHaveClass('break-words');
    const headerCell = getAllByText(longName).find(el => el.classList.contains('player-name'));
    expect(headerCell).toBeDefined();
    expect(headerCell).toHaveClass('truncate');
    expect(headerCell).toHaveAttribute('title', longName);
  });

  it('gives the red and green accents a dark-mode twin that meets AA contrast', () => {
    // text-red-500 / text-emerald-500 sit at 2.0-2.4:1 on the dark surfaces
    // (measured in review round 6); the -600 shade with a dark:-400 twin
    // clears 4.5:1 in both themes.
    useGameStore.setState({ isOnline: true, isHost: false });
    const { getByText } = render(<EndScreen />);

    const leave = getByText('end.leaveGame');
    expect(leave).toHaveClass('text-red-600', 'dark:text-red-400');
    expect(leave).not.toHaveClass('text-red-500');

    // Bob: 5000 points over 10 rounds → the "Avg Pts / Round" cell.
    const avg = getByText('500');
    expect(avg).toHaveClass('text-emerald-600', 'dark:text-emerald-400');
    expect(avg).not.toHaveClass('text-emerald-500');
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
    // Asserted against the mock, not against the DOM: react-chartjs-2 is
    // mocked to render null at the top of this file, so `querySelector(
    // 'canvas')` was null in every state the component can be in — including
    // the one where the chart IS rendered. chartCapture is only written when
    // <Line> is actually mounted, which is the thing being tested.
    chartCapture.data = null;
    useGameStore.setState({ chartLabels: [] });

    render(<EndScreen />);

    expect(chartCapture.data, 'the chart rendered with no rounds to plot').toBeNull();
  });

  it('keeps a departed player\'s chart line, frozen with the roster snapshot', () => {
    // The server splices the chart trio in lockstep with the roster when a
    // player leaves post-game. The table deliberately freezes the roster —
    // the chart must freeze with it, or the two panels contradict each other.
    useGameStore.setState({
      players: [
        { name: 'Alice', score: 10000, position: 1, color: '#ff0000' },
        { name: 'Bob', score: 5000, position: 2, color: '#00ff00' },
      ],
      chartNames: ['Alice', 'Bob'],
      chartValues: [[100, 10000], [200, 5000]],
      chartLabels: [1, 2],
    });
    render(<EndScreen theme="light" deviceId="" />);

    act(() => {
      // Bob leaves the room after game over.
      useGameStore.setState({
        players: [{ name: 'Alice', score: 10000, position: 1, color: '#ff0000' }],
        chartNames: ['Alice'],
        chartValues: [[100, 10000]],
        chartLabels: [1, 2],
      });
    });

    const datasets = (chartCapture.data as { datasets: ChartDataset[] }).datasets;
    expect(datasets).toHaveLength(2);
    expect(datasets.map(d => d.label)).toEqual(['Alice', 'Bob']);
  });

  describe('Play Again minimum players (online)', () => {
    it('blocks Play Again when opponents have LEFT the room (not merely disconnected)', () => {
      // A leaver is spliced out server-side, so waitingForReconnect never
      // sees them — without its own roster check the end screen could start
      // the 1-player online game the lobby forbids (a guaranteed "win" that
      // farms stats).
      useGameStore.setState({
        isOnline: true, isHost: true,
        players: [{ name: 'Alice', score: 10000, position: 1 }],
        sortedPlayers: [{ name: 'Alice', score: 10000, position: 1 }],
      });
      const { getByText } = render(<EndScreen />);

      expect(getByText('end.tooFewPlayers').closest('button')).toBeDisabled();
    });

    it('keeps Play Again available for an online rematch with enough players', () => {
      useGameStore.setState({
        isOnline: true, isHost: true,
        players: [
          { name: 'Alice', score: 10000, position: 1 },
          { name: 'Bob', score: 5000, position: 2 },
        ],
      });
      const { getByText } = render(<EndScreen />);

      expect(getByText('end.playAgain').closest('button')).not.toBeDisabled();
    });
  });

  describe('classic chain row in the game-stats table', () => {
    it('shows each player\'s longest chain and a received-only Feuerwerk row for a classic game', () => {
      useGameStore.setState({
        ruleset: 'classic',
        players: [
          { name: 'Alice', score: 10000, position: 1, mostCardsInTurn: 3, timesFeuerwerkReceived: 2 },
          // Bob never took a turn (e.g. a first-round Kleeblatt win) — the
          // record is genuinely absent, not zero.
          { name: 'Bob', score: 5000, position: 2 },
        ],
      });
      const { getByText, queryByText } = render(<EndScreen />);

      expect(getByText('end.mostCardsInTurn')).toBeInTheDocument();
      expect(getByText('3')).toBeInTheDocument();
      expect(getByText('–')).toBeInTheDocument();
      // Classic never attributes points to the Feuerwerk card — the row
      // shows how often it was drawn, without an invented "0 points".
      expect(getByText('end.feuerwerkReceivedStat')).toBeInTheDocument();
      expect(queryByText('end.feuerwerkStat')).not.toBeInTheDocument();
    });

    it('keeps the modernized table unchanged (no chain row, Feuerwerk with points)', () => {
      const { getByText, queryByText } = render(<EndScreen />);

      expect(queryByText('end.mostCardsInTurn')).not.toBeInTheDocument();
      expect(queryByText('end.feuerwerkReceivedStat')).not.toBeInTheDocument();
      expect(getByText('end.feuerwerkStat')).toBeInTheDocument();
    });
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
    // vi.restoreAllMocks() restores SPIES; the tests below assign global.fetch
    // directly, which it cannot undo. Left alone, the last fetch a test
    // assigned answers for every later test that forgets to assign its own —
    // which passes, for the wrong reason. Putting the shared stub back
    // (setupTests.tsx, which rejects anything it does not recognise) makes a
    // forgotten assignment fail loudly instead.
    const sharedFetchStub = globalThis.fetch;
    afterEach(() => {
      vi.restoreAllMocks();
      globalThis.fetch = sharedFetchStub;
    });

    it('does not fetch device stats for local games', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn();
      useGameStore.setState({ isOnline: false });

      render(<EndScreen deviceId="device-local-1" />);

      // Nothing fetches synchronously anyway — the first request is debounced by
      // STATS_FETCH_INITIAL_DELAY_MS — so the whole window in which a request
      // could be made has to be advanced through, retries included. Asserting
      // before that passes just as happily with the local-game guard deleted.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          STATS_FETCH_INITIAL_DELAY_MS + STATS_FETCH_RETRY_DELAY_MS * (STATS_FETCH_MAX_RETRIES + 1)
        );
      });

      expect(global.fetch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    // The request lived past the component: unmounting set isMounted=false and
    // cleared the pending timer, but an already in-flight fetch kept running to
    // completion and its resolution then scheduled a fresh retry timer — whose
    // callback returned immediately on the isMounted guard, so nothing broke,
    // it was just work nobody would ever read. On a phone leaving the end
    // screen mid-retry that is a request and a wakeup for nothing.
    it('abandons an in-flight stats request when the end screen goes away', async () => {
      vi.useFakeTimers();
      const abortSignals: AbortSignal[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) abortSignals.push(init.signal);
        // Never settles on its own — the abort is the only thing that can end it.
        return new Promise(() => {});
      }) as typeof fetch);
      useGameStore.setState({ isOnline: true });

      const { unmount } = render(<EndScreen deviceId="device-abort-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATS_FETCH_INITIAL_DELAY_MS);
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(abortSignals[0], 'the request must be cancellable at all').toBeDefined();
      expect(abortSignals[0].aborted).toBe(false);

      unmount();

      expect(abortSignals[0].aborted).toBe(true);
      vi.useRealTimers();
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

      // The id rides the header, never the URL — see deviceStatsRequest.
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/stats/device?mode=normalized',
        // objectContaining, not an exact match: the request also carries the
        // AbortSignal that cancels it on unmount, which is not what this asserts.
        expect.objectContaining({ headers: { 'x-tutto-device': 'device-online-1' } }),
      );
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

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/stats/device?mode=custom',
        // objectContaining, not an exact match: the request also carries the
        // AbortSignal that cancels it on unmount, which is not what this asserts.
        expect.objectContaining({ headers: { 'x-tutto-device': 'device-online-2' } }),
      );
      vi.useRealTimers();
    });

    it('says which bucket the lifetime numbers came from after a custom game', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 3, wins: 1, pointsDeducted: 0, kniffelCompleted: 2 }),
      }));
      useGameStore.setState({ isOnline: true, winningScore: 1000 });

      const { getByText } = render(<EndScreen deviceId="device-online-3" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getByText('end.customGameNotice')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('says nothing extra after a normal game', async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ gamesPlayed: 3, wins: 1, pointsDeducted: 0, kniffelCompleted: 2 }),
      }));
      useGameStore.setState({ isOnline: true });

      const { queryByText } = render(<EndScreen deviceId="device-online-4" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(queryByText('end.customGameNotice')).not.toBeInTheDocument();
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

    it('celebrates nothing after a custom game, however good the numbers are', () => {
      // A stacked deck or a shortened winning score cannot buy a personal
      // best: the game is recorded in its own bucket, and the snapshot these
      // compare against is not even fetched for one. Staged here with a
      // snapshot present and beaten, so only the mode can be suppressing it.
      setupOnlineGame({
        winningScore: 1000,
        preGameStats: { highestTurnScore: 100, fastestWinTurns: 99, fastestLossTurns: 99 },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);

      expect(queryByText('end.newRecordsTitle')).not.toBeInTheDocument();
      expect(queryByText('end.newPersonalBestTurnScore')).not.toBeInTheDocument();
      expect(queryByText('end.newFastestWin')).not.toBeInTheDocument();
    });

    it('still celebrates the same numbers in a normal game', () => {
      // The mirror of the case above — proving the suppression is the mode,
      // not the staged numbers.
      setupOnlineGame({
        preGameStats: { highestTurnScore: 100, fastestWinTurns: 99, fastestLossTurns: 99 },
      });
      const { getByText } = render(<EndScreen deviceId="d1" />);

      expect(getByText('end.newRecordsTitle')).toBeInTheDocument();
    });

    // "Fastest" is a count of turns taken, so a seat that never got one
    // compares 0 against every stored record and wins. Reachable when the
    // game ends before the round comes round — the player is told they set a
    // personal best in a game they did not play a turn of.
    it('claims no speed record for a player who never took a turn', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Carol',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500 },
          { name: 'Carol', score: 0, position: 2, totalTurns: 0, highestTurnScore: 0 },
        ],
        preGameStats: { highestTurnScore: 800, fastestWinTurns: 20, fastestLossTurns: 20 },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);

      expect(queryByText('end.newFastestLoss')).not.toBeInTheDocument();
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

    it('celebrates the two classic records the snapshot never used to carry', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500, mostCardsInTurn: 6, highestForfeitedTurnScore: 2200 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: {
          highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
          mostCardsInTurn: 4, highestForfeitedTurnScore: 1900,
        },
      });
      const { getByText } = render(<EndScreen deviceId="d1" />);
      expect(getByText('end.newMostCardsInTurn')).toBeInTheDocument();
      expect(getByText('end.newHighestForfeitedTurn')).toBeInTheDocument();
    });

    it('does not flag a classic record this game merely tied', () => {
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500, mostCardsInTurn: 4, highestForfeitedTurnScore: 1900 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: {
          highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
          mostCardsInTurn: 4, highestForfeitedTurnScore: 1900,
        },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newMostCardsInTurn')).not.toBeInTheDocument();
      expect(queryByText('end.newHighestForfeitedTurn')).not.toBeInTheDocument();
      expect(queryByText('end.newRecordsTitle'), 'a tie is not a record').not.toBeInTheDocument();
    });

    it('does not flag a classic record in a modernized game, whose turns are one card', () => {
      // One card per turn: mostCardsInTurn is never written at all (the engine
      // only keeps it on the classic branch), so an absent value must not read
      // as "beat the stored 4".
      useGameStore.setState({
        isOnline: true,
        myName: 'Alice',
        players: [
          { name: 'Alice', score: 10000, position: 1, totalTurns: 8, highestTurnScore: 1500 },
          { name: 'Bob', score: 5000, position: 2, totalTurns: 12, highestTurnScore: 800 },
        ],
        preGameStats: {
          highestTurnScore: 1500, fastestWinTurns: 8, fastestLossTurns: null,
          mostCardsInTurn: 4, highestForfeitedTurnScore: 1900,
        },
      });
      const { queryByText } = render(<EndScreen deviceId="d1" />);
      expect(queryByText('end.newMostCardsInTurn')).not.toBeInTheDocument();
      expect(queryByText('end.newHighestForfeitedTurn')).not.toBeInTheDocument();
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
