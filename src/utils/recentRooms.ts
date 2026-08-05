// The `tutto_recent_rooms` localStorage shape and its parser, kept together
// the way diceTurnState.ts owns the saved dice snapshot. It lives outside
// OnlineLobby.tsx because a component module may only export components
// (react-refresh/only-export-components).

export interface RecentRoom {
  roomId: string;
  name: string;
  timestamp: number;
}

// How many rooms the "Recent Rooms" shortcut list remembers. Applied on read
// as well as on write — see parseRecentRooms.
export const MAX_RECENT_ROOMS = 5;

const isPlausibleRecentRoom = (v: unknown): v is RecentRoom => {
  if (typeof v !== 'object' || v === null) return false;
  const room = v as Record<string, unknown>;
  return typeof room.roomId === 'string' && room.roomId.length > 0
    && typeof room.name === 'string' && room.name.length > 0
    // Rendered through `new Date(...)`, which turns anything else into
    // "Invalid Date" rather than failing.
    && typeof room.timestamp === 'number' && Number.isFinite(room.timestamp);
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
    return parsed.filter(isPlausibleRecentRoom).slice(0, MAX_RECENT_ROOMS);
  } catch {
    return [];
  }
};
