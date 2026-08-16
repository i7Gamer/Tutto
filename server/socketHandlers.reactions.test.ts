/**
 * @vitest-environment node
 *
 * In-process socket suite for emoji reactions (socketReactionHandlers.ts).
 * Split out of socketHandlers.test.ts along the handler-module lines; the
 * database module is mocked (see socketTestHarness.ts on why in-process).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('./database', () => ({
  updateDeviceStats: vi.fn(),
  updateGlobalStats: vi.fn(),
  getDeviceStats: vi.fn().mockResolvedValue(null),
}));

import { startInProcessServer, settle, type InProcessServer } from './socketTestHarness';

describe('emoji reactions', () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startInProcessServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('broadcasts a whitelisted reaction to everyone in the room, with sender identity attached', async () => {
    const alice = await server.connectAndJoin('REACT_ROOM_A', 'Alice', 'dev-react-1');
    const bob = await server.connectAndJoin('REACT_ROOM_A', 'Bob', 'dev-react-2');

    const received = new Promise<{ emoji: string; senderName: string; senderColor: string }>(resolve =>
      bob.on('playerReaction', resolve)
    );

    alice.emit('sendReaction', { emoji: '🔥' });

    const payload = await received;
    expect(payload.emoji).toBe('🔥');
    expect(payload.senderName).toBe('Alice');
    expect(payload.senderColor).toBe('#ff0000');
  });

  it('rejects an emoji outside the fixed whitelist (no broadcast)', async () => {
    const alice = await server.connectAndJoin('REACT_ROOM_B', 'Alice', 'dev-react-3');
    const bob = await server.connectAndJoin('REACT_ROOM_B', 'Bob', 'dev-react-4');

    let received = false;
    bob.on('playerReaction', () => { received = true; });

    // Reaction cooldown/whitelist checks are synchronous — no async I/O — so
    // settle()'s short margin is enough to prove the reaction was dropped.
    alice.emit('sendReaction', { emoji: '<script>alert(1)</script>' });
    await settle();

    expect(received).toBe(false);
  });

  it('does nothing for a socket that has not joined any room', async () => {
    const rogue = await server.connect();

    let threw = false;
    rogue.on('connect_error', () => { threw = true; });
    rogue.emit('sendReaction', { emoji: '❤️' });
    await settle();

    expect(threw).toBe(false);
  });

  it('broadcasts at most one reaction per second per connection', async () => {
    const alice = await server.connectAndJoin('REACT_ROOM_C', 'Alice', 'dev-react-5');
    const bob = await server.connectAndJoin('REACT_ROOM_C', 'Bob', 'dev-react-6');

    let received = 0;
    bob.on('playerReaction', () => { received += 1; });

    // Three rapid-fire reactions well inside one cooldown window — only the
    // first may go out.
    alice.emit('sendReaction', { emoji: '🔥' });
    alice.emit('sendReaction', { emoji: '❤️' });
    alice.emit('sendReaction', { emoji: '🔥' });
    await settle();

    expect(received).toBe(1);
  });
});
