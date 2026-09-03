// The `tutto_online_session` sessionStorage shape and its parser, kept
// together the way recentRooms.ts owns the remembered-room list and
// diceTurnState.ts the saved dice snapshot. The store re-exports the type
// (storeTypes.ts) so the slices need not reach into utils for it.

import { MAX_PLAYER_NAME_LENGTH, isPlausibleRoomId, normalizeRoomId } from './configValidation';

/** The seat this device held, so a reload can offer to reclaim it. */
// The sessionStorage key the online seat is remembered under. One constant,
// imported everywhere, so a typo cannot silently read a key nothing writes.
export const ONLINE_SESSION_KEY = 'tutto_online_session';

export interface ReconnectSession {
  roomId: string;
  myName: string;
}

/**
 * Reads back a stored reconnect session, or null if it is not usable.
 *
 * This was the last untrusted storage read left with a bare cast: whatever
 * `JSON.parse` produced went straight into `pendingReconnectSession`, which
 * App's RestoreSessionPopup renders into its prose and hands to joinRoom on
 * "Yes". A truncated or half-written entry ({} being the plain case) therefore
 * asked the player whether to reconnect to "room (undefined)" and, if they
 * agreed, asked the server for a room named `undefined`.
 *
 * Whole-value rejection: the two fields describe one seat, so a session with
 * only one of them names nothing to reconnect to. Callers drop the entry from
 * storage on null, otherwise the same broken value is re-read on every mount.
 *
 * The room id is normalised BEFORE it is validated, exactly as
 * parseRecentRooms does it: an entry written before ids were case-folded
 * everywhere still holds whatever case the player typed, and a whitespace-only
 * id passes the length bound but is empty once trimmed.
 */
export const parseReconnectSession = (raw: string | null): ReconnectSession | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const session = parsed as Record<string, unknown>;
  if (typeof session.roomId !== 'string' || typeof session.myName !== 'string') return null;

  const roomId = normalizeRoomId(session.roomId);
  const myName = session.myName;
  if (!isPlausibleRoomId(roomId)) return null;
  if (myName.length === 0 || myName.length > MAX_PLAYER_NAME_LENGTH) return null;

  return { roomId, myName };
};
