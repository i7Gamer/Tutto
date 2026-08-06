import { useEffect, useState } from 'react';
import { readRoomFromSearch, stripRoomFromUrl } from '../utils/roomLink';

/**
 * The room a shared join link is asking for, or null on an ordinary visit.
 *
 * Read once, from the URL the app started on, and held for the life of the
 * component: the param is taken back out of the address bar immediately (so a
 * refresh does not re-apply the invitation, and the code does not linger in
 * history), which would otherwise pull the value out from under whatever is
 * still rendering with it.
 *
 * Deliberately does not join anything. The player still has to supply a name,
 * and silently joining a room because someone sent a link is a surprise — the
 * link fills the code in, they tap Join.
 */
export const useRoomLink = (): string | null => {
  const [roomId] = useState(() => readRoomFromSearch(window.location.search));

  useEffect(() => {
    if (!roomId) return;
    window.history.replaceState({}, '', stripRoomFromUrl(window.location.href));
  }, [roomId]);

  return roomId;
};
