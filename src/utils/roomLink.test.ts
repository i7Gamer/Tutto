import { describe, it, expect } from 'vitest';
import {
  ROOM_LINK_PARAM, buildRoomLink, readRoomFromSearch, readScannedLink, stripRoomFromUrl,
} from './roomLink';
import { MAX_ROOM_ID_LENGTH } from './configValidation';

describe('buildRoomLink', () => {
  it('points at the page it was built from, with the room attached', () => {
    expect(buildRoomLink('ROOM1', 'https://tutto.example.com/')).toBe(
      'https://tutto.example.com/?room=ROOM1'
    );
  });

  it('keeps a sub-path deploy intact', () => {
    // base: './' in vite.config.js means the app can be served from a subpath,
    // so the link has to carry the path it is actually running under.
    expect(buildRoomLink('ROOM1', 'https://example.com/games/tutto/')).toBe(
      'https://example.com/games/tutto/?room=ROOM1'
    );
  });

  it('drops any query and hash already on the page', () => {
    // Whatever brought the host here is not part of an invitation — including
    // a room param from the link they themselves followed.
    expect(buildRoomLink('NEW', 'https://example.com/?room=OLD&debug=1#section')).toBe(
      'https://example.com/?room=NEW'
    );
  });

  it('escapes a room code that would otherwise change the URL', () => {
    expect(buildRoomLink('a b&c=d', 'https://example.com/')).toBe(
      'https://example.com/?room=a+b%26c%3Dd'
    );
  });

  it('works on a plain-http LAN address, which is how the image is often run', () => {
    expect(buildRoomLink('ROOM1', 'http://192.168.1.5:3001/')).toBe(
      'http://192.168.1.5:3001/?room=ROOM1'
    );
  });
});

describe('readRoomFromSearch', () => {
  it('reads the room the link carries', () => {
    expect(readRoomFromSearch('?room=ROOM1')).toBe('ROOM1');
    expect(readRoomFromSearch(`?a=1&${ROOM_LINK_PARAM}=ROOM1&b=2`)).toBe('ROOM1');
  });

  it('decodes an escaped room code', () => {
    expect(readRoomFromSearch('?room=a+b%26c')).toBe('a b&c');
  });

  it('trims surrounding whitespace', () => {
    expect(readRoomFromSearch('?room=%20ROOM1%20')).toBe('ROOM1');
  });

  it('returns null when there is no room to read', () => {
    expect(readRoomFromSearch('')).toBeNull();
    expect(readRoomFromSearch('?other=1')).toBeNull();
    expect(readRoomFromSearch('?room=')).toBeNull();
    expect(readRoomFromSearch('?room=%20%20')).toBeNull();
  });

  it('rejects a room code the server would never accept', () => {
    // Same bound the remembered-rooms cache applies, and the same one
    // socketHandlers enforces on joinRoom — a link is no more trusted than a
    // hand-edited localStorage entry.
    const overlong = 'R'.repeat(MAX_ROOM_ID_LENGTH + 1);
    expect(readRoomFromSearch(`?room=${overlong}`)).toBeNull();
    expect(readRoomFromSearch(`?room=${'R'.repeat(MAX_ROOM_ID_LENGTH)}`)).toHaveLength(
      MAX_ROOM_ID_LENGTH
    );
  });
});

describe('readScannedLink', () => {
  const HERE = 'https://tutto.example.com/lobby';

  it('reads the room out of an invite for this same server', () => {
    expect(readScannedLink('https://tutto.example.com/?room=ROOM1', HERE)).toEqual({
      kind: 'room',
      roomId: 'ROOM1',
    });
  });

  it('refuses an invite for a different server', () => {
    // A scanned code is arbitrary text from the physical world. Nothing here
    // ever navigates to it, so a link elsewhere cannot be followed — and
    // taking just the room code out of it would join a same-named room on
    // whichever server the scanner happens to be pointed at.
    expect(readScannedLink('https://evil.example/?room=ROOM1', HERE)).toEqual({
      kind: 'foreign-origin',
    });
    // Same host, different scheme and port are still different origins.
    expect(readScannedLink('http://tutto.example.com/?room=ROOM1', HERE)).toEqual({
      kind: 'foreign-origin',
    });
  });

  it('reports a code that is not an invite at all', () => {
    expect(readScannedLink('https://tutto.example.com/', HERE)).toEqual({ kind: 'not-an-invite' });
    expect(readScannedLink('ROOM1', HERE)).toEqual({ kind: 'not-an-invite' });
    expect(readScannedLink('', HERE)).toEqual({ kind: 'not-an-invite' });
  });

  it.each(['WIFI:S=coffee;;', 'tel:+441234567890', 'mailto:someone@example.com'])(
    'reports the everyday QR code %s as no invite rather than a foreign server',
    code => {
      // These all parse as URLs, and every one has an opaque origin that would
      // otherwise compare unequal and read as "an invite for somewhere else".
      expect(readScannedLink(code, HERE)).toEqual({ kind: 'not-an-invite' });
    }
  );

  it('applies the same room validation as a typed or remembered code', () => {
    const overlong = 'R'.repeat(MAX_ROOM_ID_LENGTH + 1);
    expect(readScannedLink(`https://tutto.example.com/?room=${overlong}`, HERE)).toEqual({
      kind: 'not-an-invite',
    });
  });

  it('accepts a plain-http LAN invite when that is where we are', () => {
    expect(readScannedLink('http://192.168.1.5:3001/?room=R1', 'http://192.168.1.5:3001/')).toEqual({
      kind: 'room',
      roomId: 'R1',
    });
  });
});

describe('stripRoomFromUrl', () => {
  it('removes the room so a refresh does not re-apply the link', () => {
    expect(stripRoomFromUrl('https://example.com/?room=ROOM1')).toBe('https://example.com/');
  });

  it('leaves every other parameter and the hash alone', () => {
    expect(stripRoomFromUrl('https://example.com/?a=1&room=ROOM1&b=2#top')).toBe(
      'https://example.com/?a=1&b=2#top'
    );
  });

  it('is a no-op on a URL that carries no room', () => {
    expect(stripRoomFromUrl('https://example.com/?a=1')).toBe('https://example.com/?a=1');
  });
});
