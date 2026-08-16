/**
 * Shared harness for the socket test suites.
 *
 * Two families use it, and they differ in what "the server" is:
 *
 *  - The subprocess suites (sockets.*.test.ts, socket.test.ts, ...) spawn the
 *    real server via startTestServer below. They were one 2455-line file with
 *    53 tests; vitest parallelises across files but never within one, so that
 *    single file serialised every test it held. Ports are allocated per file
 *    and must stay unique across the whole suite; testPorts.ts owns that
 *    allocation and rejects duplicates at import.
 *
 *  - The in-process suites (socketHandlers.*.test.ts) run registerSocketHandlers
 *    inside the test process via startInProcessServer, so the database module
 *    can be mocked (DB failures injected, awaits held open) and the handler
 *    code shows up in coverage. These listen on port 0 — an OS-assigned
 *    ephemeral port — so they need no testPorts entry and cannot collide.
 *
 * The fake-socket unit suites (socketRoomHandlers.test.ts etc.) additionally
 * share makeFakeSocket, which drives a handler function directly with no
 * network at all.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server, type Socket } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { vi } from 'vitest';
import dotenv from 'dotenv';
import { registerSocketHandlers } from './socketHandlers';

dotenv.config();

// TEST_TIMER_SCALE (see vite.config.js) compresses the spawned server's own
// timers, so orchestration waits in the tests have to scale with them or they
// would wait far longer than the behaviour they are pacing. Mirrors the same
// computation in turnTimers.ts and socketHandlers.ts.
const SCALE = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
export const testDelay = (ms: number) => Math.max(20, Math.floor(ms * SCALE));

export interface StartTestServerOptions {
  /** Extra child env on top of the inherited process.env (e.g. API_TOKEN, CORS_ORIGIN, NODE_ENV). */
  env?: Record<string, string>;
  /**
   * stderr lines containing any of these are not echoed — for suites whose
   * tests intentionally produce server-side error output (e.g. the crash-log
   * endpoint logging '[client-error]'), so real failures stay visible without
   * the expected noise.
   */
  quietStderr?: string[];
}

/**
 * Spawns the real server as a child process and resolves once it reports BOTH
 * that it is listening and that its in-memory database finished migrating.
 * FORCE_INIT_DB makes the child run migrations so the endGameStats persistence
 * assertions observe real writes — resolving on "listening" alone would race
 * them against a half-ready database.
 */
export const startTestServer = (
  port: string,
  { env = {}, quietStderr = [] }: StartTestServerOptions = {},
): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const serverProcess = spawn(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), 'server/index.ts'],
      {
        env: { ...process.env, PORT: port, FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2', ...env },
        stdio: 'pipe',
      },
    );

    let stdout = '';
    let dbReady = false;
    let serverListening = false;
    const maybeResolve = () => { if (dbReady && serverListening) resolve(serverProcess); };

    serverProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
      if (stdout.includes('Server running on port')) { serverListening = true; maybeResolve(); }
      if (stdout.includes('Database migrated to the latest version')) { dbReady = true; maybeResolve(); }
    });

    serverProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      if (quietStderr.some(pattern => text.includes(pattern))) return;
      console.error(`Server stderr (port ${port}):`, text);
    });

    serverProcess.on('error', reject);
  });

// ---------------------------------------------------------------------------
// In-process server (socketHandlers.*.test.ts)
// ---------------------------------------------------------------------------

// What joinRoom acks with. The optional fields only appear on some paths
// (name/isHost on seatings, socketId for callers that address other players),
// so suites assert on exactly the ones their scenario produces.
export interface JoinAck {
  success: boolean;
  error?: string;
  name?: string;
  isHost?: boolean;
  socketId?: string;
}

// Every suite joins with a color; which one is irrelevant to all of them.
const DEFAULT_JOIN_COLOR = '#ff0000';

/** Emits joinRoom on an already-connected socket and resolves with the raw ack. */
export const emitJoin = (
  sock: ClientSocket,
  roomId: string,
  name: string,
  deviceId: string,
  color: string = DEFAULT_JOIN_COLOR,
): Promise<JoinAck> =>
  new Promise(resolve => {
    sock.emit('joinRoom', { roomId, name, deviceId, color }, resolve);
  });

export interface InProcessServer {
  io: Server;
  port: number;
  /** Opens a client socket (tracked for close()) and resolves once connected. */
  connect(opts?: Partial<ManagerOptions & SocketOptions>): Promise<ClientSocket>;
  /** connect() + joinRoom, resolving with the ack — rejected joins included. */
  joinRaw(roomId: string, name: string, deviceId: string): Promise<{ sock: ClientSocket; res: JoinAck }>;
  /** connect() + joinRoom, throwing when the join is rejected. */
  connectAndJoin(roomId: string, name: string, deviceId: string): Promise<ClientSocket>;
  /** Disconnects every socket connect() opened, then closes the server. */
  close(): Promise<void>;
}

/**
 * The in-process counterpart to startTestServer: a socket.io server with the
 * real handlers registered, in this very process. Handler code counts toward
 * coverage and a vi.mock('./database') in the calling suite reaches it — which
 * is the only way to inject DB failures or hold a join's stats fetch open.
 * Env read at registration time (e.g. SOCKET_CONN_LIMIT_MAX) must be set
 * before calling this.
 */
export const startInProcessServer = async (): Promise<InProcessServer> => {
  const httpServer = createServer();
  const io = new Server(httpServer);
  registerSocketHandlers(io);
  await new Promise<void>(resolve => httpServer.listen(0, () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  const sockets: ClientSocket[] = [];

  const connect = (opts: Partial<ManagerOptions & SocketOptions> = {}): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'], ...opts });
      sockets.push(sock);
      sock.on('connect', () => resolve(sock));
      sock.on('connect_error', reject);
    });

  const joinRaw = async (roomId: string, name: string, deviceId: string): Promise<{ sock: ClientSocket; res: JoinAck }> => {
    const sock = await connect();
    const res = await emitJoin(sock, roomId, name, deviceId);
    return { sock, res };
  };

  const connectAndJoin = async (roomId: string, name: string, deviceId: string): Promise<ClientSocket> => {
    const { sock, res } = await joinRaw(roomId, name, deviceId);
    if (!res.success) throw new Error(res.error);
    return sock;
  };

  const close = (): Promise<void> =>
    new Promise(resolve => {
      sockets.forEach(s => s.disconnect());
      io.close(() => resolve());
    });

  return { io, port, connect, joinRaw, connectAndJoin, close };
};

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

const WAIT_FOR_TIMEOUT_MS = 3000;
const WAIT_FOR_POLL_MS = 25;

/** Polls until cond() holds, failing the test loudly instead of hanging it. */
export const waitFor = async (
  cond: () => boolean,
  timeoutMs: number = WAIT_FOR_TIMEOUT_MS,
  pollMs: number = WAIT_FOR_POLL_MS,
): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, pollMs));
  }
};

const SETTLE_DEFAULT_MS = 100;

/**
 * A short fixed margin for negative assertions — "and nothing further
 * happened". Only sound where the path under test is synchronous or settles on
 * the microtask queue (mocked DB promises, in-memory checks): a real await
 * chain needs waitFor on a positive signal instead.
 */
export const settle = (ms: number = SETTLE_DEFAULT_MS): Promise<void> =>
  new Promise(r => setTimeout(r, ms));

/**
 * Wraps a socket listener that asserts, so an expect() throwing inside one
 * rejects the test instead of escaping as an unhandled listener error — which
 * leaves the test's promise unsettled and reports a generic "Test timed out",
 * losing the assertion message that actually broke.
 */
export const asserting = <A extends unknown[]>(
  reject: (reason?: unknown) => void,
  listener: (...args: A) => void,
) => (...args: A): void => {
  try {
    listener(...args);
  } catch (e) {
    reject(e);
  }
};

// ---------------------------------------------------------------------------
// Fake socket (handler unit suites)
// ---------------------------------------------------------------------------

export type Handler = (...args: unknown[]) => unknown;

/**
 * A minimal socket double for driving a register*Handlers function directly:
 * captures the wired listeners off `on` so a test can invoke them as plain
 * functions (the registrars wrap them through safeOn, which swallows the
 * returned promise).
 */
export const makeFakeSocket = (id: string) => {
  const handlers: Record<string, Handler> = {};
  const socket = {
    id,
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    on: (event: string, fn: Handler) => { handlers[event] = fn; },
  } as unknown as Socket;
  return { socket, handlers };
};
