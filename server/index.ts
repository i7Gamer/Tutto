import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerSocketHandlers } from './socketHandlers';
import { registerApiRoutes } from './api';
import { initDb } from './database';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection, shutting down:', reason);
  process.exit(1);
});

// Defaults to '*' (any origin) to preserve local-dev/LAN-play behaviour when
// unset. Set CORS_ORIGIN to the deployed origin (e.g. https://tutto.rzipas.win)
// in production to lock this down.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

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
