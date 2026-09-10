import type { IncomingMessage } from 'http';

export type SocketCorsOrigin = string | false;
export const PENDING_ADMISSION_TIMEOUT_MS = 5_000;

export const normalizeConfiguredOrigin = (raw: string): string => {
  if (raw !== raw.trim()) throw new Error('Socket origin must not contain surrounding whitespace');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Socket origin must be a complete http(s) origin');
  }
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const isOriginOnly = parsed.username === '' && parsed.password === ''
    && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  if (!isHttp || !isOriginOnly) throw new Error('Socket origin must be a complete http(s) origin');
  return parsed.origin;
};

const directRequestOrigin = (req: IncomingMessage): string | null => {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return null;
  const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
  try {
    return normalizeConfiguredOrigin(`${encrypted ? 'https' : 'http'}://${host}`);
  } catch {
    return null;
  }
};

export const isInitialSocketOriginAllowed = (
  req: IncomingMessage,
  allowedOrigin: SocketCorsOrigin,
): boolean => {
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return true;
  if (typeof rawOrigin !== 'string' || rawOrigin === 'null') return false;

  let requestOrigin: string;
  try {
    requestOrigin = normalizeConfiguredOrigin(rawOrigin);
  } catch {
    return false;
  }
  if (allowedOrigin === '*') return true;
  if (allowedOrigin === false) return requestOrigin === directRequestOrigin(req);
  return requestOrigin === normalizeConfiguredOrigin(allowedOrigin);
};

type AllowRequestCallback = (error: string | null, success: boolean) => void;

interface EngineEvents {
  on(event: 'connection', listener: (socket: { request: IncomingMessage }) => void): unknown;
  on(event: 'connection_error', listener: (error: { req?: IncomingMessage }) => void): unknown;
}

interface SocketAdmissionOptions {
  allowedOrigin: SocketCorsOrigin;
  maxConcurrentTransports: number;
  activeClients: () => number;
}

export interface SocketAdmission {
  allowRequest(req: IncomingMessage, callback: AllowRequestCallback): void;
  bindEngine(engine: EngineEvents): void;
  release(req: IncomingMessage): void;
  pendingCount(): number;
}

export const createSocketAdmission = (options: SocketAdmissionOptions): SocketAdmission => {
  const pendingRequests = new WeakMap<IncomingMessage, () => void>();
  let pendingAdmissions = 0;

  const release = (req: IncomingMessage): void => {
    const cleanup = pendingRequests.get(req);
    if (!cleanup) return;
    pendingRequests.delete(req);
    cleanup();
    pendingAdmissions -= 1;
  };

  return {
    allowRequest(req, callback) {
      if (req.socket.destroyed) {
        callback('Connection is closed', false);
        return;
      }
      if (pendingRequests.has(req)) {
        callback(null, true);
        return;
      }
      if (!isInitialSocketOriginAllowed(req, options.allowedOrigin)) {
        callback('Socket origin is not allowed', false);
        return;
      }
      if (options.activeClients() + pendingAdmissions >= options.maxConcurrentTransports) {
        callback('Server is at transport capacity', false);
        return;
      }
      const closed = () => release(req);
      const abort = () => {
        // Destroy first: freeing a still-live handshake could allow it to
        // complete later above the active-plus-pending capacity limit.
        req.socket.destroy();
        release(req);
      };
      const deadline = setTimeout(abort, PENDING_ADMISSION_TIMEOUT_MS);
      deadline.unref();
      pendingRequests.set(req, () => {
        clearTimeout(deadline);
        req.socket.off('close', closed);
        req.socket.off('error', abort);
        req.off('aborted', abort);
      });
      req.socket.once('close', closed);
      req.socket.once('error', abort);
      req.once('aborted', abort);
      pendingAdmissions += 1;
      callback(null, true);
    },
    bindEngine(engine) {
      engine.on('connection', socket => release(socket.request));
      engine.on('connection_error', error => {
        if (error.req) release(error.req);
      });
    },
    release,
    pendingCount: () => pendingAdmissions,
  };
};
