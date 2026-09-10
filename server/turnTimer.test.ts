/** @vitest-environment node */
/** Server-authoritative turn expiry, driven through protocol-v2 actions only. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket as ClientSocket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { startInProcessServer, emitJoin, waitFor, type InProcessServer } from './socketTestHarness';
import { deleteRoom, rooms } from './rooms';
import { normalizeRoomId, DEFAULT_WINNING_SCORE } from '../src/utils/configValidation';
import type { OnlineGameAction } from '../src/types';
import type { GameStore } from '../src/store/storeTypes';
import { nonNull } from '../src/testing/factories';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(), updateGlobalStats: vi.fn(), getDeviceStats: vi.fn().mockResolvedValue(null),
}));

type GameStatePayload = Partial<GameStore> & { gameplayToken?: string };
const TURN_DURATION_S = 30;
const TWO_SEATS = 2;
const ONLY_200 = { '200': 8 };
const latest = new WeakMap<ClientSocket, GameStatePayload>();

describe('Server-side turn timer', () => {
  let server: InProcessServer;

  beforeAll(async () => { server = await startInProcessServer(); });
  afterAll(async () => { await server.close(); });

  const room = (roomId: string) => nonNull(rooms[normalizeRoomId(roomId)]);
  const waitForState = (sock: ClientSocket, predicate: (state: GameStatePayload) => boolean) => new Promise<GameStatePayload>((resolve, reject) => {
    const current = latest.get(sock);
    if (current && predicate(current)) { resolve(current); return; }
    const timeout = setTimeout(() => { sock.off('gameState', receive); reject(new Error('Timed out waiting for game state')); }, 6000);
    const receive = (state: GameStatePayload) => {
      latest.set(sock, state);
      if (!predicate(state)) return;
      clearTimeout(timeout); sock.off('gameState', receive); resolve(state);
    };
    sock.on('gameState', receive);
  });
  const join = async (roomId: string, name: string) => {
    const sock = await server.connect();
    sock.on('gameState', (state: GameStatePayload) => latest.set(sock, state));
    const stateWait = waitForState(sock, state => state.players?.some(player => player.name === name) === true);
    const ack = await emitJoin(sock, roomId, name, `dev-${roomId}-${name}`);
    if (!ack.success) throw new Error(ack.error);
    await stateWait;
    return { sock, socketId: nonNull(ack.socketId) };
  };
  const configure = async (sock: ClientSocket, roomId: string, config: Record<string, unknown>) => {
    const state = waitForState(sock, candidate => Object.entries(config)
      .every(([key, value]) => JSON.stringify(candidate[key as keyof GameStatePayload]) === JSON.stringify(value)));
    sock.emit('updateConfig', { roomId, ...config });
    return state;
  };
  const action = async (sock: ClientSocket, roomId: string, actionValue: OnlineGameAction) => {
    const send = async (base: string) => new Promise<{ ok: boolean; gameplayToken?: string; reason?: string }>(resolve => sock.emit('pushState', {
      roomId, base, mutationId: randomUUID(), action: actionValue, newState: {},
    }, resolve));
    let ack = await send(nonNull(latest.get(sock)?.gameplayToken));
    if (!ack.ok && ack.reason === 'stale-base') {
      const refreshed = new Promise<GameStatePayload>(resolve => {
        sock.once('gameState', (state: GameStatePayload) => { latest.set(sock, state); resolve(state); });
        sock.emit('requestState', { roomId });
      });
      ack = await send(nonNull((await refreshed).gameplayToken));
    }
    if (!ack.ok) throw new Error(`Action ${actionValue.type} refused: ${ack.reason}`);
    return waitForState(sock, state => state.gameplayToken === ack.gameplayToken);
  };
  const start = async (roomId: string, host: ClientSocket, config: Record<string, unknown> = {}) => {
    await configure(host, roomId, { initialCards: ONLY_200, randomOrder: false, turnDuration: TURN_DURATION_S, ...config });
    return action(host, roomId, { type: 'start' });
  };
  const commit = (sock: ClientSocket, roomId: string, score = 0, success = false) =>
    action(sock, roomId, { type: 'commit', score, success });
  const waitForTimer = (roomId: string) => waitFor(() => room(roomId).turnExpireTimer !== null);
  const fireTimer = (roomId: string) => {
    const timer = room(roomId).turnExpireTimer;
    expect(timer).not.toBeNull();
    const run = (timer as unknown as { _onTimeout?: () => void })._onTimeout;
    expect(typeof run).toBe('function');
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    (run as () => void)();
  };
  const close = (...sockets: ClientSocket[]) => sockets.forEach(socket => socket.disconnect());

  it('auto-advances without a client action', async () => {
    const id = 'TIMER-AUTO'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await waitForTimer(id);
    const advanced = waitForState(alice.sock, state => state.currentPlayerIndex === 1);
    fireTimer(id); const state = await advanced;
    expect(state.previousCard).toBe('200');
    expect(nonNull(state.players).find(player => player.name === 'Alice')?.busts).toBe(1);
    expect(nonNull(state.historyLog)[0]).toMatchObject({ playerName: 'Alice', type: 'bust', card: '200' });
    close(alice.sock, bob.sock);
  });

  it('continues after host disconnect', async () => {
    const id = 'TIMER-HOST-GONE'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await waitForTimer(id); alice.sock.disconnect();
    await waitFor(() => room(id).state.players.some(player => player.name === 'Alice' && player.disconnected));
    const advanced = waitForState(bob.sock, state => state.currentPlayerIndex === 1);
    fireTimer(id); expect((await advanced).status).toBe('playing'); close(bob.sock);
  });

  it('advances with every client disconnected and exposes the result on rejoin', async () => {
    const id = 'TIMER-EMPTY'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await waitForTimer(id); alice.sock.disconnect(); bob.sock.disconnect();
    await waitFor(() => room(id).state.players.every(player => player.disconnected)); fireTimer(id);
    const observer = await join(id, 'Alice'); const state = nonNull(latest.get(observer.sock));
    expect(nonNull(state.historyLog)[0]).toMatchObject({ playerName: 'Alice', type: 'bust' });
    expect(state.currentPlayerIndex).toBe(1); close(observer.sock);
  });

  it.each([
    ['Feuerwerk', 3], ['Kleeblatt', 2],
  ] as const)('%s applies its timer multiplier', async (card, multiplier) => {
    const id = `TIMER-${card}`; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    const state = await start(id, alice.sock, { initialCards: { [card]: 8 } });
    expect(state.turnTimeRemaining).toBe(TURN_DURATION_S * multiplier); await waitForTimer(id);
    const advanced = waitForState(alice.sock, candidate => candidate.currentPlayerIndex === 1);
    fireTimer(id); expect((await advanced).previousCard).toBe(card); close(alice.sock, bob.sock);
  });

  it('does not arm a timer when disabled', async () => {
    const id = 'TIMER-DISABLED'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock, { turnDuration: 0 }); expect(room(id).turnExpireTimer).toBeNull(); close(alice.sock, bob.sock);
  });

  it('updates charts and wraps the round on a timeout', async () => {
    const id = 'TIMER-ROUND'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await commit(alice.sock, id); await waitForTimer(id);
    const wrapped = waitForState(alice.sock, state => state.round === 2); fireTimer(id); const state = await wrapped;
    expect(state.currentPlayerIndex).toBe(0); expect(nonNull(state.chartValues).every(values => values.length === 1)).toBe(true);
    expect(state.chartLabels).toEqual([1]); close(alice.sock, bob.sock);
  });

  it('finishes at a timeout after a legal two-seat score cycle and does not re-arm', async () => {
    const id = 'TIMER-GAMEOVER'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await commit(alice.sock, id, DEFAULT_WINNING_SCORE, true); await waitForTimer(id);
    const finished = waitForState(alice.sock, state => state.finished === true); fireTimer(id); const state = await finished;
    expect(state.currentPlayerIndex).toBeNull(); expect(room(id).turnExpireTimer).toBeNull(); close(alice.sock, bob.sock);
  });

  it('cancels an armed expiry when the host disables duration mid-turn', async () => {
    const id = 'TIMER-CANCEL'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await waitForTimer(id); await configure(alice.sock, id, { turnDuration: 0 });
    expect(room(id).turnExpireTimer).toBeNull(); close(alice.sock, bob.sock);
  });

  it('reschedules when kicking a mid-round active player', async () => {
    const id = 'TIMER-KICK-MID'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob'); const carol = await join(id, 'Carol');
    await start(id, alice.sock); await commit(alice.sock, id); await waitForTimer(id); const oldTimer = room(id).turnExpireTimer;
    const afterKick = waitForState(alice.sock, state => state.players?.length === TWO_SEATS && state.currentPlayerIndex === 1);
    alice.sock.emit('kickPlayer', bob.socketId); const state = await afterKick;
    expect(state.round).toBe(1); expect(room(id).turnExpireTimer).not.toBe(oldTimer); expect(state.turnTimeRemaining).toBe(TURN_DURATION_S);
    close(alice.sock, bob.sock, carol.sock);
  });

  it('bumps the round when kicking the last active player', async () => {
    const id = 'TIMER-KICK-LAST'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob'); const carol = await join(id, 'Carol');
    await start(id, alice.sock); await commit(alice.sock, id); await commit(bob.sock, id);
    const afterKick = waitForState(alice.sock, state => state.players?.length === TWO_SEATS);
    alice.sock.emit('kickPlayer', carol.socketId); const state = await afterKick;
    expect(state.round).toBe(2); expect(state.currentPlayerIndex).toBe(0); close(alice.sock, bob.sock, carol.sock);
  });

  it('clears an active player live dice snapshot on kick', async () => {
    const id = 'TIMER-KICK-LIVE'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob'); const carol = await join(id, 'Carol');
    await start(id, alice.sock); await commit(alice.sock, id);
    const live = { turnScore: 350, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 };
    const fresh = await new Promise<GameStatePayload>(resolve => {
      bob.sock.once('gameState', (state: GameStatePayload) => { latest.set(bob.sock, state); resolve(state); });
      bob.sock.emit('requestState', { roomId: id });
    });
    bob.sock.emit('liveTurnState', { roomId: id, base: nonNull(fresh.gameplayToken), liveTurnState: live });
    await waitFor(() => room(id).state.liveTurnState?.turnScore === live.turnScore);
    const kicked = waitForState(alice.sock, state => state.players?.length === TWO_SEATS);
    alice.sock.emit('kickPlayer', bob.socketId); expect((await kicked).liveTurnState).toBeNull(); close(alice.sock, bob.sock, carol.sock);
  });

  it('tolerates an orphaned timer callback after the room is deleted', async () => {
    const id = 'TIMER-DELETED'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock); await waitForTimer(id);
    const orphaned = (room(id).turnExpireTimer as unknown as { _onTimeout: () => void })._onTimeout;
    deleteRoom(normalizeRoomId(id)); expect(() => orphaned()).not.toThrow(); close(alice.sock, bob.sock);
  });

  it('clears the timer after an explicit legal Kleeblatt completion', async () => {
    const id = 'TIMER-FINISH'; const alice = await join(id, 'Alice'); const bob = await join(id, 'Bob');
    await start(id, alice.sock, { initialCards: { Kleeblatt: 8 } }); await waitForTimer(id);
    const finished = waitForState(alice.sock, state => state.finished === true);
    await commit(alice.sock, id, 0, true); await finished; expect(room(id).turnExpireTimer).toBeNull(); close(alice.sock, bob.sock);
  });
});
