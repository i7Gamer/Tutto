import { describe, it, expect } from 'vitest';
import { parseRecentRooms, MAX_RECENT_ROOMS } from './recentRooms';

const room = (roomId: string, timestamp = 1000) => ({ roomId, name: 'Bob', timestamp });
const asRaw = (value: unknown): string => JSON.stringify(value);

describe('parseRecentRooms', () => {
  it('returns an empty list for a missing or empty value', () => {
    expect(parseRecentRooms(null)).toEqual([]);
    expect(parseRecentRooms('')).toEqual([]);
  });

  it('returns an empty list for a value that is not JSON', () => {
    expect(parseRecentRooms('not json')).toEqual([]);
    expect(parseRecentRooms('{')).toEqual([]);
  });

  it('returns an empty list for JSON that is not an array', () => {
    // `{ length: n }` is the shape that used to survive the old read and then
    // throw "recentRooms.map is not a function" during render.
    expect(parseRecentRooms(asRaw({ length: 3 }))).toEqual([]);
    expect(parseRecentRooms(asRaw({}))).toEqual([]);
    expect(parseRecentRooms(asRaw(5))).toEqual([]);
    expect(parseRecentRooms(asRaw('ROOM1'))).toEqual([]);
    expect(parseRecentRooms(asRaw(null))).toEqual([]);
  });

  it('keeps a well-formed list unchanged, in order', () => {
    const stored = [room('ROOM1', 2000), room('ROOM2', 1000)];
    expect(parseRecentRooms(asRaw(stored))).toEqual(stored);
  });

  it('drops entries that are not objects', () => {
    expect(parseRecentRooms(asRaw(['ROOM1', 42, null, undefined, []]))).toEqual([]);
  });

  it('drops an entry with a missing or non-string roomId', () => {
    const bad = [
      { name: 'Bob', timestamp: 1000 },
      { roomId: { nested: 1 }, name: 'Bob', timestamp: 1000 },
      { roomId: 42, name: 'Bob', timestamp: 1000 },
      { roomId: '', name: 'Bob', timestamp: 1000 },
    ];
    expect(parseRecentRooms(asRaw(bad))).toEqual([]);
  });

  it('drops an entry with a missing or non-string name', () => {
    const bad = [
      { roomId: 'ROOM1', timestamp: 1000 },
      { roomId: 'ROOM2', name: { nested: 1 }, timestamp: 1000 },
      { roomId: 'ROOM3', name: '', timestamp: 1000 },
    ];
    expect(parseRecentRooms(asRaw(bad))).toEqual([]);
  });

  it('drops an entry whose timestamp is not a finite number', () => {
    // Fed straight to `new Date(...)` for the date label, which silently
    // renders "Invalid Date" for anything else instead of failing.
    const bad = [
      { roomId: 'ROOM1', name: 'Bob' },
      { roomId: 'ROOM2', name: 'Bob', timestamp: 'yesterday' },
      { roomId: 'ROOM3', name: 'Bob', timestamp: null },
      // JSON.stringify turns both of these into null, so they arrive as the
      // same non-number case a hand-written file would produce directly.
      { roomId: 'ROOM4', name: 'Bob', timestamp: NaN },
      { roomId: 'ROOM5', name: 'Bob', timestamp: Infinity },
    ];
    expect(parseRecentRooms(asRaw(bad))).toEqual([]);
  });

  it('accepts a zero timestamp', () => {
    // Falsy but perfectly valid — the epoch is a real date, and a `!timestamp`
    // style check would have thrown it away.
    expect(parseRecentRooms(asRaw([room('ROOM1', 0)]))).toEqual([room('ROOM1', 0)]);
  });

  it('keeps the valid entries and drops only the invalid ones', () => {
    // Per-entry filtering: these rows are independent, unlike the positionally
    // coupled arrays parseSavedDiceState rejects wholesale.
    const stored = [room('GOOD1'), { roomId: { nested: 1 } }, room('GOOD2')];
    expect(parseRecentRooms(asRaw(stored))).toEqual([room('GOOD1'), room('GOOD2')]);
  });

  it('caps the list at MAX_RECENT_ROOMS, keeping the most recent end', () => {
    // The write path already trims, so only an edited file reaches this — but
    // uncapped it renders one button per stored entry.
    const stored = Array.from({ length: MAX_RECENT_ROOMS * 2 }, (_, i) => room(`ROOM${i}`, i));
    const parsed = parseRecentRooms(asRaw(stored));
    expect(parsed).toHaveLength(MAX_RECENT_ROOMS);
    expect(parsed).toEqual(stored.slice(0, MAX_RECENT_ROOMS));
  });

  it('counts only valid entries against the cap', () => {
    const stored = [
      ...Array.from({ length: MAX_RECENT_ROOMS }, () => ({ roomId: 42 })),
      ...Array.from({ length: MAX_RECENT_ROOMS }, (_, i) => room(`GOOD${i}`, i)),
    ];
    expect(parseRecentRooms(asRaw(stored))).toHaveLength(MAX_RECENT_ROOMS);
  });
});
