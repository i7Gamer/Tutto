import { describe, it, expect } from 'vitest';
import { parseReconnectSession } from './reconnectSession';
import { MAX_PLAYER_NAME_LENGTH, MAX_ROOM_ID_LENGTH } from './configValidation';

const asRaw = (value: unknown): string => JSON.stringify(value);

describe('parseReconnectSession', () => {
  it('accepts a well-formed session', () => {
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: 'Alice' })))
      .toEqual({ roomId: 'ROOM1', myName: 'Alice' });
  });

  it('returns null for a missing or empty value', () => {
    expect(parseReconnectSession(null)).toBeNull();
    expect(parseReconnectSession('')).toBeNull();
  });

  it('returns null for a value that is not JSON', () => {
    expect(parseReconnectSession('not json')).toBeNull();
    expect(parseReconnectSession('{')).toBeNull();
  });

  // The shape the finding named: a half-written or truncated entry parses
  // fine and used to reach the restore prompt as "room (undefined)".
  it('returns null for an object missing its fields', () => {
    expect(parseReconnectSession(asRaw({}))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ myName: 'Alice' }))).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseReconnectSession(asRaw(null))).toBeNull();
    expect(parseReconnectSession(asRaw(5))).toBeNull();
    expect(parseReconnectSession(asRaw('ROOM1'))).toBeNull();
    expect(parseReconnectSession(asRaw([{ roomId: 'ROOM1', myName: 'Alice' }]))).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(parseReconnectSession(asRaw({ roomId: 1, myName: 'Alice' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: { id: 'ROOM1' }, myName: 'Alice' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: 42 }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: null }))).toBeNull();
  });

  it('returns null for an empty or whitespace-only room id', () => {
    expect(parseReconnectSession(asRaw({ roomId: '', myName: 'Alice' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: '   ', myName: 'Alice' }))).toBeNull();
  });

  it('returns null for an over-long room id', () => {
    const tooLong = 'A'.repeat(MAX_ROOM_ID_LENGTH + 1);
    expect(parseReconnectSession(asRaw({ roomId: tooLong, myName: 'Alice' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'A'.repeat(MAX_ROOM_ID_LENGTH), myName: 'Alice' })))
      .toEqual({ roomId: 'A'.repeat(MAX_ROOM_ID_LENGTH), myName: 'Alice' });
  });

  it('returns null for an empty or over-long name', () => {
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: '' }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: 'a'.repeat(MAX_PLAYER_NAME_LENGTH + 1) }))).toBeNull();
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: 'a'.repeat(MAX_PLAYER_NAME_LENGTH) })))
      .toEqual({ roomId: 'ROOM1', myName: 'a'.repeat(MAX_PLAYER_NAME_LENGTH) });
  });

  // Written before room ids were case-folded everywhere, or trailing padding
  // from a copy-pasted code — the restored session must ask the server for
  // the same room the rest of the app would.
  it('normalises the stored room id', () => {
    expect(parseReconnectSession(asRaw({ roomId: 'abc1', myName: 'Alice' })))
      .toEqual({ roomId: 'ABC1', myName: 'Alice' });
    expect(parseReconnectSession(asRaw({ roomId: '  room1  ', myName: 'Alice' })))
      .toEqual({ roomId: 'ROOM1', myName: 'Alice' });
  });

  it('keeps only the two fields it validates', () => {
    expect(parseReconnectSession(asRaw({ roomId: 'ROOM1', myName: 'Alice', isHost: true })))
      .toEqual({ roomId: 'ROOM1', myName: 'Alice' });
  });
});
