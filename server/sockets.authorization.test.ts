/**
 * @vitest-environment node
 *
 * Socket integration suite — authorization & payload validation.
 * Split out of the former monolithic sockets.test.ts; see socketTestHarness.ts
 * for why, and for the port allocation rules.
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { protocolClient as io, joinTestRoom, acceptOnlineAction, pushOnlineAction, requestPublicState } from './onlineTestClient';
import { startTestServer, type JoinAck } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import { nonNull } from '../src/testing/factories';

describe('Server Socket E2E — authorization & payload validation', () => {
  let serverProcess: ChildProcess | undefined;

  const PORT = TEST_PORTS.socketsAuthorization;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const stagePair = async (roomId: string, initialCards: Record<string, number> = { '200': 8 }) => {
    const host = io(`http://127.0.0.1:${PORT}`);
    const guest = io(`http://127.0.0.1:${PORT}`);
    await joinTestRoom(host, roomId, 'Alice', { randomOrder: false, turnDuration: 0, initialCards });
    await joinTestRoom(guest, roomId, 'Bob');
    await acceptOnlineAction(host, roomId, { type: 'start' });
    return { host, guest, cleanup: () => { host.disconnect(); guest.disconnect(); } };
  };

  it('ignores a fully formed commit from a player who is neither host nor active', async () => {
    const roomId = 'E2E_AUTH';
    const { host, guest, cleanup } = await stagePair(roomId);
    try {
      expect((await requestPublicState(guest, roomId)).currentPlayerIndex).toBe(0);
      expect(await pushOnlineAction(guest, roomId, { type: 'commit', score: 500, success: false },
        { currentPlayerIndex: 1 })).toMatchObject({ ok: false, reason: 'unauthorized' });
      const state = await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false });
      expect(state.players?.map(player => player.score)).toEqual([100, 0]);
      expect(state.currentPlayerIndex).toBe(1);
    } finally { cleanup(); }
  });

  it('does not deliver a room named after a socket id to that socket', async () => {
    const victim = io(`http://127.0.0.1:${PORT}`);
    const attacker = io(`http://127.0.0.1:${PORT}`);
    try {
      await joinTestRoom(victim, 'E2E_NS_VICTIM', 'Victim');
      const roomId = nonNull(victim.id);
      const foreign: string[] = [];
      victim.on('gameState', state => {
        if (state.players?.some((player: { name: string }) => player.name === 'Attacker')) foreign.push('gameState');
      });
      victim.on('hostId', id => { if (id !== victim.id) foreign.push('hostId'); });
      await joinTestRoom(attacker, roomId, 'Attacker');
      // reset is authorized even with a single lobby seat, and broadcasts.
      expect(await pushOnlineAction(attacker, roomId, { type: 'reset' })).toMatchObject({ ok: true });
      await requestPublicState(victim, 'E2E_NS_VICTIM');
      expect(foreign).toEqual([]);
    } finally { victim.disconnect(); attacker.disconnect(); }
  });

  it('rejects reset from a non-host active player and ignores its host-only snapshot claims', async () => {
    const roomId = 'E2E_HOSTFIELDS';
    const { host, guest, cleanup } = await stagePair(roomId);
    try {
      await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false });
      expect((await requestPublicState(guest, roomId)).currentPlayerIndex).toBe(1);
      expect(await pushOnlineAction(guest, roomId, { type: 'reset' },
        { status: 'lobby', winningScore: 7777 })).toMatchObject({ ok: false });
      const state = await acceptOnlineAction(guest, roomId, { type: 'commit', score: 100, success: false },
        { winningScore: 7777 });
      expect(state.status).toBe('playing');
      expect(state.winningScore).toBe(6000);
    } finally { cleanup(); }
  });

  it('derives a non-host Plus/Minus deduction from the host-leader without cross-seat writes', async () => {
    const roomId = 'PM_DEDUCT_ROOM';
    const { host, guest, cleanup } = await stagePair(roomId, { Plus_Minus: 8 });
    try {
      await acceptOnlineAction(host, roomId, { type: 'commit', score: 0, success: true });
      const state = await acceptOnlineAction(guest, roomId, { type: 'commit', score: 0, success: true });
      expect(state.players?.map(player => player.score)).toEqual([0, 1000]);
      expect(state.players?.[0].times1000PointsDeducted).toBe(1);
      expect(state.players?.[1].timesPlusMinusCompleted).toBe(1);
    } finally { cleanup(); }
  });

  it('allows the non-host active player to undo a canonical previous host turn', async () => {
    const roomId = 'UNDO_HOST_SCORE';
    const { host, guest, cleanup } = await stagePair(roomId);
    try {
      await acceptOnlineAction(host, roomId, { type: 'commit', score: 500, success: false });
      const state = await acceptOnlineAction(guest, roomId, { type: 'undo' });
      expect(state.players?.map(player => player.score)).toEqual([0, 0]);
      expect(state.currentPlayerIndex).toBe(0);
      expect(state.previousCard).toBeNull();
    } finally { cleanup(); }
  });

  it('ignores a liveTurnState claim smuggled in a gameplay snapshot', async () => {
    const roomId = 'LIVE_TURN_ROOM';
    const { host, cleanup } = await stagePair(roomId);
    try {
      const state = await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false }, {
        liveTurnState: { turnScore: 350, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
      });
      expect(state.liveTurnState).toBeNull();
    } finally { cleanup(); }
  });

  it('forwards an active player dedicated live snapshot without a full gameState broadcast', async () => {
    const roomId = 'LIVE_TURN_EVENT_ROOM';
    const { host, guest, cleanup } = await stagePair(roomId);
    try {
      const state = await acceptOnlineAction(host, roomId, { type: 'commit', score: 100, success: false });
      const fullStates: unknown[] = [];
      host.on('gameState', payload => fullStates.push(payload));
      const received = new Promise<{ liveTurnState: { turnScore: number } }>(resolve => host.once('liveTurnState', resolve));
      guest.emit('liveTurnState', { roomId, base: state.gameplayToken, liveTurnState: {
        turnScore: 425, keptDice: [{ id: 'die-1', val: 1 }], currentRoll: [{ id: 'die-2', val: 5, selected: false }],
        kniffelProgress: [], tuttosThisTurn: 0,
      } });
      expect((await received).liveTurnState.turnScore).toBe(425);
      expect(fullStates).toEqual([]);
    } finally { cleanup(); }
  });

  it('ignores a bystander live snapshot but forwards the active player follow-up', async () => {
    const roomId = 'LIVE_TURN_UNAUTH_ROOM';
    const { host, guest, cleanup } = await stagePair(roomId);
    try {
      const state = await requestPublicState(guest, roomId);
      const seen: number[] = [];
      guest.on('liveTurnState', payload => seen.push(payload.liveTurnState.turnScore));
      const snapshot = (turnScore: number) => ({ roomId, base: state.gameplayToken,
        liveTurnState: { turnScore, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 } });
      guest.emit('liveTurnState', snapshot(999));
      // The same sender's requestState is an ordered barrier after its attack.
      await requestPublicState(guest, roomId);
      const received = new Promise(resolve => guest.once('liveTurnState', resolve));
      host.emit('liveTurnState', snapshot(42));
      await received;
      expect(seen).toEqual([42]);
    } finally { cleanup(); }
  });

  it('tolerates malformed (null/primitive) socket payloads and keeps serving', async () => {
    // The old version emitted the crash attempts and then resolved on a timer
    // with no listener, no assertion on the result and no liveness check — so
    // a server that had actually died passed it. It was also the last test in
    // the file, so nothing downstream noticed either.
    //
    // Liveness is now asserted twice, from both sides: a legitimate
    // updateConfig must still be ACCEPTED AND BROADCAST after the burst, and
    // the process must still be running.
    //
    // Worth knowing what this does NOT prove: every payload below is refused
    // by a type guard before it can throw — updatePlayerColor returns on
    // `typeof color !== 'string'` without ever reaching COLOR_RE, so even the
    // throwing toString is never called. Removing safeOn's catch leaves this
    // test green. That is a property of the handlers being well guarded, not
    // a gap here; safeOn's containment needs a handler that genuinely throws,
    // and no client-supplied payload reaches one.
    interface MalformedPayloadObserved {
      nullJoinRefused: boolean;
      joined: boolean;
      stillServing: boolean;
    }
    const observed = await new Promise<MalformedPayloadObserved>((resolve, reject) => {
      const roomId = 'MALFORMED_PAYLOAD_TEST_ROOM';
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const seen: MalformedPayloadObserved = { nullJoinRefused: false, joined: false, stillServing: false };

      const giveUp = setTimeout(() => {
        s1.disconnect();
        reject(new Error('the server never answered the initial join'));
      }, 8000);

      s1.on('gameState', (state) => {
        if (state.winningScore === 5000) seen.stillServing = true;
      });

      s1.on('connect', () => {
        // Emit null to joinRoom
        s1.emit('joinRoom', null, (res: JoinAck) => {
          seen.nullJoinRefused = res.success === false;

          // Join properly
          s1.emit('joinRoom', { roomId, name: 'Alice', deviceId: 'dev-mal-a', color: '#ff0000' }, (res2: JoinAck) => {
            seen.joined = res2.success === true;

            // Send malformed configs, colors, reactions, and pushState
            s1.emit('updateConfig', null);
            s1.emit('updateConfig', 'string-payload');
            s1.emit('reorderPlayers', null);
            s1.emit('updatePlayerColor', null);
            s1.emit('updatePlayerColor', { roomId, color: null });
            s1.emit('updatePlayerColor', { roomId, color: { toString: () => { throw new Error('crash') } } });
            s1.emit('sendReaction', null);
            s1.emit('pushState', null);
            s1.emit('submitGlobalStats', null);
            s1.emit('endGameStats', null);

            // Then a well-formed one: its broadcast is the proof the server is
            // not merely un-crashed but still SERVING this room.
            setTimeout(() => {
              s1.emit('updateConfig', { roomId, winningScore: 5000 });
              setTimeout(() => {
                clearTimeout(giveUp);
                s1.disconnect();
                resolve(seen);
              }, 300);
            }, 150);
          });
        });
      });
    });

    expect(observed.nullJoinRefused, 'a null joinRoom must be refused, not accepted').toBe(true);
    expect(observed.joined, 'the well-formed join never succeeded, so nothing was tested').toBe(true);
    expect(observed.stillServing, 'the server stopped answering after the malformed burst').toBe(true);
    expect(nonNull(serverProcess).exitCode, 'the server process died on a malformed payload').toBeNull();
  }, 15000);
});
