import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore, _resetTimersForTests } from './useGameStore';
import { createInitialPlayer } from './gameSlice';

const SCORE = 500;

beforeEach(() => {
  useGameStore.getState().reset();
  useGameStore.setState({
    isOnline: true, mode: 'online', isHost: true, roomId: 'DECK',
    players: [createInitialPlayer('Alice'), createInitialPlayer('Bob')],
    randomOrder: false, pushState: vi.fn(), syncOnlineTimers: vi.fn(),
    remainingCardCounts: { Stop: 1, '200': 1 },
  });
});
afterEach(() => { _resetTimersForTests(); vi.restoreAllMocks(); });

describe('online card prediction', () => {
  it('starts without constructing a local ordered deck', () => {
    const random = vi.spyOn(Math, 'random');
    useGameStore.getState().startGame();
    expect(useGameStore.getState().cards).toEqual([]);
    expect(useGameStore.getState().currentCard).toBeNull();
    expect(random).not.toHaveBeenCalled();
    expect(useGameStore.getState().pushState).toHaveBeenCalledWith(null, { type: 'start' });
  });

  it('predicts score but waits for the server to reveal the next card', () => {
    useGameStore.setState({ status: 'playing', currentPlayerIndex: 0, currentCard: '300', cards: [] });
    const random = vi.spyOn(Math, 'random');
    useGameStore.getState().nextTurn(SCORE, true);
    expect(useGameStore.getState().players[0].score).toBe(SCORE);
    expect(useGameStore.getState().currentCard).toBe('300');
    expect(useGameStore.getState().cards).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expect(useGameStore.getState().pushState).toHaveBeenCalledWith(null, { type: 'commit', score: SCORE, success: true });
  });

  it('undo keeps the online deck empty while restoring scores', () => {
    useGameStore.setState({ status: 'playing', currentPlayerIndex: 0, currentCard: '300' });
    useGameStore.getState().nextTurn(SCORE, true);
    useGameStore.setState({ currentCard: '200' });
    useGameStore.getState().undo();
    expect(useGameStore.getState().players[0].score).toBe(0);
    expect(useGameStore.getState().currentCard).toBe('200');
    expect(useGameStore.getState().cards).toEqual([]);
    expect(useGameStore.getState().pushState).toHaveBeenLastCalledWith(null, { type: 'undo' });
  });

  it('local next-turn still draws from the private offline deck', () => {
    useGameStore.setState({ isOnline: false, mode: 'local', currentPlayerIndex: 0, currentCard: '300', cards: ['200', 'Stop'] });
    useGameStore.getState().nextTurn(SCORE, true);
    expect(useGameStore.getState().currentCard).toBe('200');
    expect(useGameStore.getState().cards).toEqual(['Stop']);
  });
});
