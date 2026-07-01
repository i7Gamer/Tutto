import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EndScreen from './EndScreen';
import { useGameStore } from '../store/useGameStore';

// Capture the chart's `data` prop instead of rendering a real canvas.
const chartCapture = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('react-chartjs-2', () => ({
  Line: (props: { data: unknown }) => {
    chartCapture.data = props.data;
    return null;
  },
}));

interface ChartDataset { label: string; data: number[]; borderColor: string; backgroundColor: string }

describe('EndScreen Component', () => {
  beforeEach(() => {
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

  describe('device stats fetching', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      useGameStore.setState({ isOnline: false });
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

      expect(global.fetch).toHaveBeenCalledWith('/api/stats/device-online-1');
      vi.useRealTimers();
    });
  });
});
