/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { roomPhase } from './roomPhase';

describe('roomPhase', () => {
  it('reads lobby from status alone', () => {
    expect(roomPhase({ status: 'lobby', finished: false })).toBe('lobby');
  });

  it('reads playing from status once a game has started', () => {
    expect(roomPhase({ status: 'playing', finished: false })).toBe('playing');
  });

  it('reads finished once the flag is set, even though status stays playing', () => {
    // The whole reason this helper exists: Play Again never passes back
    // through the lobby, so a finished game's wire state is still
    // status: 'playing'.
    expect(roomPhase({ status: 'playing', finished: true })).toBe('finished');
  });

  it('lets finished win over an incoherent status: lobby', () => {
    // Never produced by normal play (see roomPhase.ts's doc comment), but a
    // malformed push or a hand-built fixture could still construct it. A
    // finished verdict must never be readable as a live game, so `finished`
    // wins regardless of what `status` says.
    expect(roomPhase({ status: 'lobby', finished: true })).toBe('finished');
  });
});
