/** @vitest-environment node */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
import { createSocketAdmission } from './socketAdmission';

const ALLOWED_ORIGIN = 'https://tutto.rzipas.win';
const FOREIGN_ORIGIN = 'https://hostile.example';
const CONNECT_TIMEOUT_MS = 2_000;

interface RunningServer { httpServer: HttpServer; io: SocketServer; port: number }

const startAdmissionServer = async (maxConcurrentTransports: number): Promise<RunningServer> => {
  const httpServer = createServer();
  let io: SocketServer;
  const admission = createSocketAdmission({
    allowedOrigin: ALLOWED_ORIGIN,
    maxConcurrentTransports,
    activeClients: () => io?.engine.clientsCount ?? 0,
  });
  io = new SocketServer(httpServer, {
    cors: { origin: ALLOWED_ORIGIN },
    allowRequest: admission.allowRequest,
    transports: ['polling', 'websocket'],
  });
  admission.bindEngine(io.engine);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, io, port: (httpServer.address() as AddressInfo).port };
};

const closeAdmissionServer = async ({ io }: RunningServer): Promise<void> => {
  await new Promise<void>(resolve => io.close(() => resolve()));
};

const openSocket = (
  port: number,
  origin: string | undefined,
  transports: Array<'polling' | 'websocket'>,
): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    transports,
    extraHeaders: origin === undefined ? undefined : { Origin: origin },
    reconnection: false,
    forceNew: true,
    timeout: CONNECT_TIMEOUT_MS,
  });
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', error => { socket.close(); reject(error); });
});

const expectRejected = async (
  port: number,
  origin: string,
  transports: Array<'polling' | 'websocket'>,
): Promise<void> => {
  await expect(openSocket(port, origin, transports)).rejects.toBeInstanceOf(Error);
};

describe('real Engine.IO origin admission', () => {
  let running: RunningServer;
  beforeAll(async () => { running = await startAdmissionServer(10); });
  afterAll(async () => closeAdmissionServer(running));

  it.each([
    [['websocket'] as Array<'websocket'>],
    [['polling'] as Array<'polling'>],
  ])('rejects a foreign Origin on an initial %s handshake', async transports => {
    await expectRejected(running.port, FOREIGN_ORIGIN, transports);
  });

  it.each(['null', 'not a url'])('rejects malformed Origin %j', async origin => {
    await expectRejected(running.port, origin, ['websocket']);
  });

  it('allows an Origin-less native client', async () => {
    const socket = await openSocket(running.port, undefined, ['websocket']);
    socket.close();
  });

  it('allows the configured Origin to establish polling and upgrade to WebSocket', async () => {
    const socket = await openSocket(running.port, ALLOWED_ORIGIN, ['polling', 'websocket']);
    await expect.poll(() => socket.io.engine.transport.name, { timeout: CONNECT_TIMEOUT_MS }).toBe('websocket');
    socket.close();
  });
});

describe('real Engine.IO concurrent transport capacity', () => {
  let running: RunningServer;
  beforeAll(async () => { running = await startAdmissionServer(1); });
  afterAll(async () => closeAdmissionServer(running));

  it('reclaims capacity after ws rejects an admitted malformed upgrade', async () => {
    await expect.poll(() => running.io.engine.clientsCount).toBe(0);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: running.port,
        path: '/socket.io/?EIO=4&transport=websocket',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13' },
      }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    const legitimate = await openSocket(running.port, undefined, ['polling']);
    legitimate.close();
    await expect.poll(() => running.io.engine.clientsCount).toBe(0);
  });

  it('rejects above the cap and admits again after the active transport closes', async () => {
    const first = await openSocket(running.port, undefined, ['websocket']);
    await expect(openSocket(running.port, undefined, ['websocket'])).rejects.toBeInstanceOf(Error);
    first.close();
    await expect.poll(() => running.io.engine.clientsCount, { timeout: CONNECT_TIMEOUT_MS }).toBe(0);
    const replacement = await openSocket(running.port, undefined, ['websocket']);
    replacement.close();
  });
});
