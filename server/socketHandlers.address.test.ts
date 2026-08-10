/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import { getClientAddress } from './socketHandlers';

const fakeSocket = (address: string, xff?: string): Socket => ({
  handshake: { address, headers: xff ? { 'x-forwarded-for': xff } : {} },
}) as unknown as Socket;

describe('getClientAddress', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY=1 — even in production', () => {
    // Whether a trusted proxy fronts this server is a topology fact only the
    // deployer knows. NODE_ENV=production used to imply it, so a production
    // build exposed DIRECTLY let any client forge the header and mint itself
    // a fresh rate-limiter bucket per connection.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUST_PROXY', '');
    expect(getClientAddress(fakeSocket('9.9.9.9', '1.2.3.4'))).toBe('9.9.9.9');
  });

  it('uses the rightmost X-Forwarded-For entry when TRUST_PROXY=1', () => {
    // The rightmost entry is the one appended by the single trusted hop —
    // anything left of it is client-supplied and stays untrusted.
    vi.stubEnv('TRUST_PROXY', '1');
    expect(getClientAddress(fakeSocket('172.18.0.2', '6.6.6.6, 1.2.3.4'))).toBe('1.2.3.4');
  });

  it('falls back to the raw peer address when trusted but no header arrived', () => {
    vi.stubEnv('TRUST_PROXY', '1');
    expect(getClientAddress(fakeSocket('192.168.1.20'))).toBe('192.168.1.20');
  });
});
