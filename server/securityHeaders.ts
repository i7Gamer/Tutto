import type express from 'express';

/**
 * The response headers every answer carries, and why each is safe here:
 *
 *  - `X-Content-Type-Options: nosniff` — the server hands out user-supplied
 *    content (crash reports come back out of /api, the SPA shell is served
 *    from disk), and MIME sniffing is what turns a mislabelled response into
 *    an executed one.
 *  - `X-Frame-Options: SAMEORIGIN` — nothing embeds this app, and a game whose
 *    whole UI is buttons is a natural clickjacking target.
 *  - `Referrer-Policy: strict-origin-when-cross-origin` — a room link carries
 *    the room id in its query (`/?room=ABC`), which is the only credential
 *    needed to walk into a game. Without this, following any outbound link
 *    from that page would leak it in the Referer.
 *
 * No `Content-Security-Policy`, deliberately: Cloudflare's JS Detections
 * injects a fresh inline script into the document on every request, so no
 * static hash or nonce this server could emit would cover it, and a CSP that
 * blocks it blanks the app for everyone behind the proxy. The absence is
 * asserted in the tests so re-adding one has to be a decision.
 *
 * Also no `Strict-Transport-Security`: the documented LAN deployment is served
 * over plain HTTP (see roomLink.ts), and an HSTS header from a hostname that
 * later gets an https deployment would pin browsers to a scheme that box does
 * not answer on.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * Applies the hardening above to an express app. Mount before anything that
 * answers, so it also covers the static files and express's own 404.
 *
 * Split into its own module (rather than sitting inline in index.ts) for the
 * same reason startupGuards.ts is: index.ts starts a listening server on
 * import, so nothing in it can be unit-tested.
 */
export const applyResponseHardening = (app: express.Application): void => {
  // Express advertises itself in every response by default. It tells an
  // attacker which CVE list to work from and does nothing for anyone else.
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    next();
  });
};
