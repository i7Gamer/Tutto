// Shareable join links: `https://<wherever this is deployed>/?room=ABC`.
//
// A query parameter rather than a path segment because the app has no router —
// the server serves the SPA for any path and would have nothing to match on —
// and because the whole point is that the phone's own camera app can open it
// from a QR code without Tutto being involved.

import { isPlausibleRoomId } from './configValidation';

/** The query parameter a join link carries the room in. */
export const ROOM_LINK_PARAM = 'room';

/** The only schemes an invite is ever served over — the app runs on both. */
const WEB_PROTOCOLS = ['http:', 'https:'];

/**
 * The link to hand someone so they land on the lobby with `roomId` prefilled.
 *
 * Built from the page's own URL rather than a configured origin: the image is
 * routinely run on a plain-http LAN address, and the link has to point wherever
 * the host actually reached the app. `href` is passed in rather than read from
 * `window` so this stays testable.
 */
export const buildRoomLink = (roomId: string, href: string): string => {
  const url = new URL(href);
  // Whatever brought the host to this page is not part of an invitation — and
  // that includes the room param from a link they themselves followed.
  url.search = '';
  url.hash = '';
  url.searchParams.set(ROOM_LINK_PARAM, roomId);
  return url.toString();
};

/**
 * The room a link is asking to join, or null if it is not asking for one.
 *
 * Validated exactly as strictly as the remembered-rooms cache: a link is no
 * more trustworthy than a hand-edited localStorage entry, and both end up in
 * the same input.
 */
export const readRoomFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(ROOM_LINK_PARAM)?.trim() ?? '';
  return isPlausibleRoomId(value) ? value : null;
};

/** What a scanned QR code turned out to be. */
export type ScannedLink =
  | { kind: 'room'; roomId: string }
  | { kind: 'foreign-origin' }
  | { kind: 'not-an-invite' };

/**
 * Reads an invite out of whatever a camera just decoded.
 *
 * A scanned code is arbitrary text from the physical world, so this is the
 * boundary that keeps it harmless: nothing anywhere navigates to a scanned URL,
 * and only a link to this very deployment yields a room. Taking the room code
 * out of a foreign link instead would quietly join a same-named room on
 * whichever server the player's app happens to be pointed at — the two failure
 * modes are reported separately so the UI can say which one happened.
 */
export const readScannedLink = (text: string, currentHref: string): ScannedLink => {
  let scanned: URL;
  try {
    scanned = new URL(text);
  } catch {
    return { kind: 'not-an-invite' };
  }

  // Checked before the origin comparison: plenty of everyday QR codes parse as
  // URLs without being web links at all (`WIFI:`, `tel:`, `mailto:`), and every
  // one of them has an opaque origin that would otherwise be reported as an
  // invite for some other Tutto server.
  if (!WEB_PROTOCOLS.includes(scanned.protocol)) return { kind: 'not-an-invite' };
  if (scanned.origin !== new URL(currentHref).origin) return { kind: 'foreign-origin' };

  const roomId = readRoomFromSearch(scanned.search);
  return roomId ? { kind: 'room', roomId } : { kind: 'not-an-invite' };
};

/**
 * The same URL without the room, for `history.replaceState` once the link has
 * been applied — otherwise a refresh re-applies it, and the room code sits in
 * the address bar long after it stopped meaning anything.
 */
export const stripRoomFromUrl = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete(ROOM_LINK_PARAM);
  return url.toString();
};
