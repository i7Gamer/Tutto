/** @vitest-environment node */
/**
 * In-process tests for the response hardening index.ts applies to every
 * answer. Mounted on a bare express app here for the same reason
 * api.routes.test.ts does it: index.ts is the entry point and cannot be
 * imported without starting a server, so the hardening lives in its own
 * module and is asserted against a real HTTP round trip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type http from 'http';
import { applyResponseHardening, SECURITY_HEADERS } from './securityHeaders';

describe('response hardening', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    // Same order as index.ts: hardening first, so it covers everything mounted
    // after it — including the static files and the 404 express answers itself.
    applyResponseHardening(app);
    app.get('/thing', (_req, res) => {
      res.json({ ok: true });
    });
    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`);

  it('sends every security header on a normal answer', async () => {
    const res = await get('/thing');
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
  });

  // The headers matter most on the answers nobody wrote a handler for: a 404
  // body is still a body a browser can be talked into sniffing.
  it('sends them on a route that does not exist either', async () => {
    const res = await get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('does not announce the server framework', async () => {
    const res = await get('/thing');
    expect(res.headers.get('X-Powered-By')).toBeNull();
  });

  // Named individually rather than only through the loop above, so changing a
  // value has to be a deliberate edit to this list too.
  it('pins the header values', () => {
    expect(SECURITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });

  // The app is a PWA served from its own origin and embeds nothing; a CSP is
  // deliberately absent (see the module comment). This asserts the absence so
  // adding one is a decision, not an accident: a wrong CSP here blanks the app.
  it('sends no Content-Security-Policy', async () => {
    const res = await get('/thing');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });
});
