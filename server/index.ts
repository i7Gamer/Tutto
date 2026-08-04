import path from 'path';
import dotenv from 'dotenv';
// quiet: true suppresses dotenv's startup banner, which is noise in a
// container where configuration arrives as real env vars and no .env exists.
dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true });

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerSocketHandlers } from './socketHandlers';
import { registerApiRoutes } from './api';
import { initDb } from './database';
import { resolveCorsOrigin, validateCorsOriginForStartup } from './startupGuards';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection, shutting down:', reason);
  process.exit(1);
});

// An explicit wildcard in production would let any site make authenticated
// cross-origin requests against this server — mirrors the API_TOKEN
// production guard in api.ts. Runs before resolveCorsOrigin so a rejected
// value never reaches the middleware.
const corsOriginError = validateCorsOriginForStartup(process.env);
if (corsOriginError) {
  console.error(corsOriginError);
  process.exit(1);
}

// '*' outside production (local dev / LAN play), the explicit CORS_ORIGIN when
// one is set, and same-origin only in production when it is not.
const CORS_ORIGIN = resolveCorsOrigin(process.env);

const app = express();

// Rate limiting (server/rateLimit.ts) keys requests by req.ip. Behind a
// reverse proxy that header is meaningless unless Express is told to trust
// it and read the client IP from X-Forwarded-For instead.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  pingInterval: 4000,
  pingTimeout: 6000,
});

registerSocketHandlers(io);
registerApiRoutes(app);

const PORT = process.env.PORT || 3001;

const start = async (): Promise<void> => {
  await initDb();
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

void start();
