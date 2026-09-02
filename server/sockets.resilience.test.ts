/**
 * @vitest-environment jsdom
 *
 * Socket integration suite — a push that spans a transport drop.
 *
 * Deliberately NOT `@vitest-environment node` like its sibling sockets.*
 * suites: the behaviour under test belongs to the CLIENT, so this drives the
 * real zustand store (src/store/socketSlice.ts) with the real socket.io-client
 * against a real spawned server, in jsdom.
 *
 * Why not raw socket.io-client on both ends, the way the other suites work:
 * the bug is a client-side ordering one that a raw client cannot express.
 * socket.io-client flushes its buffered emits BEFORE it fires `connect`
 * (Socket#onconnect calls emitBuffered() ahead of emitReserved("connect")),
 * so a pushState emitted while the transport was down arrives on the NEW
 * socket id before the client has re-joined. The server has no
 * connection-state recovery, so the seat still carries the OLD socket id: the
 * push fails the host/active-player gate and is dropped. A raw-client
 * reproduction would therefore still fail after the fix, because the fix is
 * that the STORE parks the push until its rejoin has been acked. Only the real
 * store can show that, and it is also what a player actually runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { startTestServer, waitFor, connected } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import { useGameStore, _resetSocketSliceForTests } from '../src/store/useGameStore';
import { getSocket, disconnectSocket } from '../src/store/socketRef';
import type { JoinAck } from './socketTestHarness';

const PORT = TEST_PORTS.socketsResilience;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const ROOM_ID = 'RESILIENCE_ROOM';

// socket.io-client's default reconnectionDelay is 1s with a 0.5 randomization
// factor, and the rejoin plus the flushed push are two more round trips on top
// of that — well past waitFor's 3s default, and nowhere near a hang.
const RECONNECT_WAIT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

// Alice is seated first and is therefore the host; Bob only exists so the room
// has a second seat that survives Alice's drop, and so the assertion can be
// made from a socket that never went away.
const FIRST_ROUND = 1;
const SECOND_ROUND = 2;

describe('Server Socket E2E — a push made while the transport is down', () => {
  let serverProcess: Awaited<ReturnType<typeof startTestServer>>;
  let observer: ClientSocket | null = null;

  beforeAll(async () => {
    serverProcess = await startTestServer(PORT);
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    observer?.disconnect();
    disconnectSocket();
    _resetSocketSliceForTests();
    useGameStore.getState().reset();
    if (serverProcess) serverProcess.kill();
  });

  it('lands the push after the rejoin instead of losing it to the reconnect', async () => {
    useGameStore.getState().reset();
    useGameStore.setState({ deviceId: 'dev-resilience-alice' });

    // The store's own socket, pointed at the spawned server. joinRoom below
    // calls connectSocket() with no url, which is a no-op once one exists.
    useGameStore.getState().connectSocket(SERVER_URL);
    const joined = await useGameStore.getState().joinRoom(ROOM_ID, 'Alice');
    expect(joined.success).toBe(true);

    // The witness: a plain client in the same room, so what is asserted is
    // what the SERVER broadcast, not what the pushing store believes.
    observer = io(SERVER_URL);
    await connected(observer);
    let observedRound: number | null = null;
    let observedStatus: string | null = null;
    observer.on('gameState', (state: { round: number; status: string }) => {
      observedRound = state.round;
      observedStatus = state.status;
    });
    const bobJoin = await new Promise<JoinAck>(resolve => {
      observer?.emit('joinRoom', {
        roomId: ROOM_ID, name: 'Bob', deviceId: 'dev-resilience-bob', color: '#00ff00',
      }, resolve);
    });
    expect(bobJoin.success).toBe(true);

    // The host starts the game. The roster comes from the server's own
    // broadcast, so the push cannot trip applyPushedState's stale-roster gate.
    await waitFor(() => useGameStore.getState().players.length === 2);
    useGameStore.setState({ status: 'playing', currentPlayerIndex: 0, round: FIRST_ROUND });
    useGameStore.getState().pushState();
    await waitFor(() => observedStatus === 'playing' && observedRound === FIRST_ROUND);

    // Kill the transport the way a tunnel or a sleeping phone does — the
    // manager reconnects on its own, which is exactly the window the bug
    // lives in.
    getSocket()?.io.engine.close();
    await waitFor(() => getSocket()?.connected === false);

    // The move the player made while the connection was down.
    useGameStore.setState({ round: SECOND_ROUND });
    useGameStore.getState().pushState();

    await waitFor(() => observedRound === SECOND_ROUND, RECONNECT_WAIT_MS);
    expect(observedRound).toBe(SECOND_ROUND);
  }, TEST_TIMEOUT_MS);
});
