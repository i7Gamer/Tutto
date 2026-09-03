// The `tutto_recent_rooms` localStorage shape and its parser, kept together
// the way diceTurnState.ts owns the saved dice snapshot. It lives outside
// OnlineLobby.tsx because a component module may only export components
// (react-refresh/only-export-components).

import { MAX_PLAYER_NAME_LENGTH, isPlausibleRoomId, normalizeRoomId } from './configValidation';

export interface RecentRoom {
  roomId: string;
  name: string;
  timestamp: number;
}

// How many rooms the "Recent Rooms" shortcut list remembers. Applied on read
// as well as on write — see parseRecentRooms.
export const MAX_RECENT_ROOMS = 5;

// The largest millisecond offset from the epoch `new Date(...)` can represent,
// in either direction. Beyond it the value is still a finite number and still
// renders as the string "Invalid Date".
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

// Room ids are case-insensitive everywhere now (normalizeRoomId at every
// client entry point and server handler), but a list written BEFORE that
// still holds whatever case the player typed. Canonicalising on read folds
// "abc1" onto "ABC1" so the two do not render as separate rows — and so the
// dedupe below sees one id, not two — and the next join rewrites the list in
// canonical form. Validated AFTER normalising: a whitespace-only id is
// plausible by length and empty once trimmed.
const toPlausibleRecentRoom = (v: unknown): RecentRoom | null => {
  if (typeof v !== 'object' || v === null) return null;
  const room = v as Record<string, unknown>;
  if (typeof room.roomId !== 'string') return null;
  const roomId = normalizeRoomId(room.roomId);
  const plausible = isPlausibleRoomId(roomId)
    && typeof room.name === 'string'
    && room.name.length > 0 && room.name.length <= MAX_PLAYER_NAME_LENGTH
    // Rendered through `new Date(...)`, which turns anything else into
    // "Invalid Date" rather than failing. The range check also rejects NaN and
    // Infinity, both of which compare false against any bound.
    && typeof room.timestamp === 'number' && Math.abs(room.timestamp) <= MAX_TIMESTAMP_MS;
  if (!plausible) return null;
  return { roomId, name: room.name as string, timestamp: room.timestamp as number };
};

// roomId is the React key each row is rendered under (OnlineLobby.tsx), so a
// repeat is a duplicate key. The write path only removes the room being joined,
// which leaves any other duplicate already in storage untouched.
const dedupeByRoomId = (rooms: RecentRoom[]): RecentRoom[] => {
  const seen = new Set<string>();
  const unique: RecentRoom[] = [];
  for (const room of rooms) {
    if (seen.has(room.roomId)) continue;
    seen.add(room.roomId);
    unique.push(room);
  }
  return unique;
};

// This was the only localStorage read in the app that skipped shape
// validation. Every entry is rendered directly into JSX, so a well-formed-
// but-wrong value (an object where the array is expected, an object where a
// string is) threw during render and dropped the whole lobby into the
// ErrorBoundary — which reloads without clearing this key, so it just hit the
// same value again. Neither cache-clear path removes it either, leaving no
// in-app recovery.
//
// Per-entry filtering rather than the whole-array rejection parseSavedDiceState
// applies to its own arrays: those entries are positionally coupled to other
// state, these are independent rows, so one bad row is no reason to forget
// every remembered room. The next successful join rewrites the cleaned list.
export const parseRecentRooms = (raw: string | null): RecentRoom[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // De-duplicated before the cap, so five stored copies of one room do not
    // crowd out four real ones.
    const plausible = parsed
      .map(toPlausibleRecentRoom)
      .filter((room): room is RecentRoom => room !== null);
    return dedupeByRoomId(plausible).slice(0, MAX_RECENT_ROOMS);
  } catch {
    return [];
  }
};
