/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { EventEmitter } from 'node:events';
import {
  createSocketAdmission,
  isInitialSocketOriginAllowed,
  normalizeConfiguredOrigin,
  PENDING_ADMISSION_TIMEOUT_MS,
} from './socketAdmission';

const request = (
  origin: string | undefined,
  host = 'tutto.example.com',
  encrypted = false,
): IncomingMessage => Object.assign(new IncomingMessage(new Socket()), {
  headers: { ...(origin === undefined ? {} : { origin }), host },
}, { socket: Object.assign(new Socket(), { encrypted }) });

afterEach(() => { vi.useRealTimers(); });

describe('normalizeConfiguredOrigin', () => {
  it.each([
    ['https://EXAMPLE.com:443', 'https://example.com'],
    ['http://example.com:80', 'http://example.com'],
    ['http://example.com:8080', 'http://example.com:8080'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeConfiguredOrigin(raw)).toBe(expected);
  });

  it.each([
    'ftp://example.com', 'https://user@example.com', 'https://example.com/path',
    'https://example.com?x=1', 'https://example.com/#fragment', ' https://example.com',
  ])('rejects an invalid complete origin %j', raw => {
    expect(() => normalizeConfiguredOrigin(raw)).toThrow(/origin/i);
  });
});

describe('isInitialSocketOriginAllowed', () => {
  it('allows Origin-less native clients', () => {
    expect(isInitialSocketOriginAllowed(request(undefined), 'https://tutto.example.com')).toBe(true);
  });

  it('requires an exact normalized match for an explicit origin', () => {
    expect(isInitialSocketOriginAllowed(request('https://tutto.example.com:443'), 'https://tutto.example.com')).toBe(true);
    expect(isInitialSocketOriginAllowed(request('https://evil.example'), 'https://tutto.example.com')).toBe(false);
  });

  it.each(['null', 'not a url', 'ftp://tutto.example.com'])('rejects malformed browser Origin %j', origin => {
    expect(isInitialSocketOriginAllowed(request(origin), '*')).toBe(false);
  });

  it('derives same-origin only from the direct Host and actual socket scheme', () => {
    expect(isInitialSocketOriginAllowed(request('http://tutto.example.com'), false)).toBe(true);
    expect(isInitialSocketOriginAllowed(request('https://tutto.example.com'), false)).toBe(false);
    expect(isInitialSocketOriginAllowed(request('https://tutto.example.com', 'tutto.example.com', true), false)).toBe(true);
  });
});

describe('createSocketAdmission', () => {
  it('releases an aborted request and refuses a closed transport', () => {
    const admission = createSocketAdmission({ allowedOrigin: '*', maxConcurrentTransports: 1, activeClients: () => 0 });
    const req = request(undefined);
    admission.allowRequest(req, vi.fn());
    req.emit('aborted');
    expect(req.socket.destroyed).toBe(true);
    expect(admission.pendingCount()).toBe(0);
    const ack = vi.fn();
    admission.allowRequest(req, ack);
    expect(ack).toHaveBeenCalledWith(expect.any(String), false);
    expect(admission.pendingCount()).toBe(0);
  });

  it('reserves an initial request only once and transfers it on connection/error events', () => {
    const admission = createSocketAdmission({ allowedOrigin: '*', maxConcurrentTransports: 1, activeClients: () => 0 });
    const engine = new EventEmitter();
    admission.bindEngine(engine);
    const first = request(undefined);
    admission.allowRequest(first, vi.fn());
    admission.allowRequest(first, vi.fn());
    expect(admission.pendingCount()).toBe(1);
    engine.emit('connection', { request: first });
    expect(admission.pendingCount()).toBe(0);
    const second = request(undefined);
    admission.allowRequest(second, vi.fn());
    engine.emit('connection_error', {});
    expect(admission.pendingCount()).toBe(1);
    engine.emit('connection_error', { req: second });
    expect(admission.pendingCount()).toBe(0);
    expect(second.socket.listenerCount('close')).toBe(0);
  });

  it.each(['close', 'error'])('releases a pending handshake on socket %s and removes hooks', event => {
    const admission = createSocketAdmission({ allowedOrigin: '*', maxConcurrentTransports: 1, activeClients: () => 0 });
    const req = request(undefined);
    admission.allowRequest(req, vi.fn());
    req.socket.emit(event);
    expect(admission.pendingCount()).toBe(0);
    expect(req.socket.listenerCount('close')).toBe(0);
    expect(req.socket.listenerCount('error')).toBe(0);
    expect(req.listenerCount('aborted')).toBe(0);
    admission.release(req);
    expect(admission.pendingCount()).toBe(0);
  });

  it('destroys an abandoned handshake before its bounded reservation expires', () => {
    vi.useFakeTimers();
    const admission = createSocketAdmission({ allowedOrigin: '*', maxConcurrentTransports: 1, activeClients: () => 0 });
    const req = request(undefined);
    const destroy = vi.spyOn(req.socket, 'destroy').mockImplementation(() => {
      expect(admission.pendingCount()).toBe(1);
      return req.socket;
    });
    admission.allowRequest(req, vi.fn());
    vi.advanceTimersByTime(PENDING_ADMISSION_TIMEOUT_MS);
    expect(destroy).toHaveBeenCalledOnce();
    expect(admission.pendingCount()).toBe(0);
    expect(req.socket.listenerCount('close')).toBe(0);
  });

  it('cancels expiry on successful release so an accepted transport stays open', () => {
    vi.useFakeTimers();
    const admission = createSocketAdmission({ allowedOrigin: '*', maxConcurrentTransports: 1, activeClients: () => 0 });
    const req = request(undefined);
    const destroy = vi.spyOn(req.socket, 'destroy');
    admission.allowRequest(req, vi.fn());
    admission.release(req);
    vi.advanceTimersByTime(PENDING_ADMISSION_TIMEOUT_MS);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('reserves pending initial handshakes and rejects at active plus pending capacity', () => {
    let active = 1;
    const admission = createSocketAdmission({
      allowedOrigin: '*', maxConcurrentTransports: 2, activeClients: () => active,
    });
    const first = request(undefined);
    const second = request(undefined);
    const firstDone = vi.fn();
    const secondDone = vi.fn();

    admission.allowRequest(first, firstDone);
    admission.allowRequest(second, secondDone);

    expect(firstDone).toHaveBeenCalledWith(null, true);
    expect(secondDone).toHaveBeenCalledWith(expect.stringMatching(/capacity/i), false);
    expect(admission.pendingCount()).toBe(1);

    active = 2;
    admission.release(first);
    expect(admission.pendingCount()).toBe(0);
  });

  it('rejects a hostile origin without spending capacity and releases idempotently', () => {
    const admission = createSocketAdmission({
      allowedOrigin: 'https://tutto.example.com', maxConcurrentTransports: 1, activeClients: () => 0,
    });
    const hostile = request('https://evil.example');
    const done = vi.fn();
    admission.allowRequest(hostile, done);
    expect(done).toHaveBeenCalledWith(expect.stringMatching(/origin/i), false);
    expect(admission.pendingCount()).toBe(0);

    const allowed = request('https://tutto.example.com');
    admission.allowRequest(allowed, vi.fn());
    admission.release(allowed);
    admission.release(allowed);
    expect(admission.pendingCount()).toBe(0);
  });
});
