/**
 * @vitest-environment node
 *
 * The per-address cap on room CREATION.
 *
 * MAX_ROOMS alone bounds the total, but nothing bounded how many of those 500
 * one client could hold. deviceId is client-chosen, so the one-room-per-device
 * rule costs an attacker nothing: join with a fresh deviceId, set
 * reconnectTimeout to its 3600s maximum in initialConfig (joinRoom applies the
 * joiner's config to the room it has just created), then hard-disconnect. The
 * seat's reconnect timer is armed for an hour, and isAbandonedRoom requires an
 * EMPTY timer map — so the room cannot be freed, and there is no sweeper. At
 * the connection limiter's ~3/s that is every slot on the server in under three
 * minutes, and every real player gets `server_full` until the timers drain.
 *
 * Its own file rather than another describe in socketHandlers.rooms.test.ts:
 * `rooms` is module state shared across describes there, and a cap that counts
 * rooms is exactly the thing another describe's leftovers would perturb.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { startInProcessServer, type InProcessServer, type JoinAck } from './socketTestHarness';
import { rooms, deleteRoom, createRoom, countRoomsCreatedBy } from './rooms';
import { MAX_RECONNECT_TIMEOUT } from '../src/utils/configValidation';

// Low enough to reach in three joins. The real default is generous; what is
// under test is that a bound exists and where it bites, not its value.
const CAP = 2;

describe('per-address room-creation cap', () => {
  let server: InProcessServer;
  const originalCap = process.env.MAX_ROOMS_PER_ADDRESS;

  beforeAll(async () => {
    // Read at registration time, like SOCKET_CONN_LIMIT_MAX — set before the
    // server is started.
    process.env.MAX_ROOMS_PER_ADDRESS = String(CAP);
    server = await startInProcessServer();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.MAX_ROOMS_PER_ADDRESS;
    else process.env.MAX_ROOMS_PER_ADDRESS = originalCap;
    await server.close();
  });

  // Every test starts from an empty server, so none of them depends on the
  // order the others ran in.
  beforeEach(() => {
    Object.keys(rooms).forEach(id => deleteRoom(id));
  });

  const join = async (roomId: string, device: string): Promise<JoinAck> =>
    (await server.joinRaw(roomId, `P-${device}`, device)).res;

  // Every socket in this file connects from 127.0.0.1, so the wire tests below
  // cannot tell "rooms this address created" from "rooms" — a count that
  // ignored createdBy passed all of them. Seeded rooms are the only way to put
  // a second address in play.
  describe('countRoomsCreatedBy', () => {
    it('counts only the rooms that address created', () => {
      rooms['SEED_X1'] = createRoom('sock-x1', '10.0.0.1');
      rooms['SEED_X2'] = createRoom('sock-x2', '10.0.0.1');
      rooms['SEED_Y1'] = createRoom('sock-y1', '10.0.0.2');

      expect(countRoomsCreatedBy('10.0.0.1')).toBe(2);
      expect(countRoomsCreatedBy('10.0.0.2')).toBe(1);
      expect(countRoomsCreatedBy('10.0.0.3')).toBe(0);
    });

    it('attributes an unattributed room to nobody', () => {
      // createRoom's default — a room a test seeded directly. Counting those
      // against the empty address would let one suite's fixtures exhaust the
      // cap for the next.
      rooms['SEED_Z1'] = createRoom('sock-z1');

      expect(countRoomsCreatedBy('')).toBe(0);
    });
  });

  it('refuses to create more rooms than the cap allows from one address', async () => {
    expect((await join('CAPADDR_A', 'dev-a')).success).toBe(true);
    expect((await join('CAPADDR_B', 'dev-b')).success).toBe(true);

    const refused = await join('CAPADDR_C', 'dev-c');

    expect(refused.success).toBe(false);
    expect(refused.code).toBe('too_many_rooms');
    expect(rooms['CAPADDR_C'], 'the room must not exist at all').toBeUndefined();
  });

  it('still lets that address JOIN an existing room while at the cap', async () => {
    await join('CAPADDR_A', 'dev-a');
    await join('CAPADDR_B', 'dev-b');

    // Joining costs no room slot, so the cap has nothing to say about it —
    // the same distinction MAX_ROOMS already draws.
    const res = await join('CAPADDR_A', 'dev-joiner');

    expect(res.success).toBe(true);
    expect(rooms['CAPADDR_A'].state.players).toHaveLength(2);
  });

  it('frees the slot again when one of its rooms goes away', async () => {
    await join('CAPADDR_A', 'dev-a');
    await join('CAPADDR_B', 'dev-b');
    expect((await join('CAPADDR_C', 'dev-c')).success).toBe(false);

    deleteRoom('CAPADDR_B');

    // Counted live off `rooms`, like the one-room-per-device rule above it,
    // so there is no separate tally that could go stale.
    expect((await join('CAPADDR_D', 'dev-d')).success).toBe(true);
  });

  it('caps the hostile shape specifically: max reconnectTimeout plus a drop', async () => {
    // The amplifier the finding turns on — a room created with the longest
    // reconnect window, then abandoned. Without the cap this is repeatable
    // until every one of MAX_ROOMS is held.
    const openGhost = async (roomId: string, deviceId: string): Promise<void> => {
      const sock = await server.connect();
      await new Promise<JoinAck>(resolve => sock.emit('joinRoom', {
        roomId,
        name: deviceId,
        deviceId,
        color: '#ff0000',
        initialConfig: { reconnectTimeout: MAX_RECONNECT_TIMEOUT },
      }, resolve));
      sock.disconnect();
    };

    await openGhost('CAPADDR_GHOST_1', 'dev-g1');
    await openGhost('CAPADDR_GHOST_2', 'dev-g2');

    // Both rooms are still standing — a pending reconnect timer is exactly
    // what isAbandonedRoom refuses to free — so the third creation is refused.
    expect(rooms['CAPADDR_GHOST_1']).toBeDefined();
    expect(rooms['CAPADDR_GHOST_2']).toBeDefined();

    const refused = await join('CAPADDR_GHOST_3', 'dev-g3');

    expect(refused.code).toBe('too_many_rooms');
  });
});
