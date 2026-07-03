import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerSocketHandlers } from './socketHandlers';
import { registerApiRoutes } from './api';

// Defaults to '*' (any origin) to preserve local-dev/LAN-play behaviour when
// unset. Set CORS_ORIGIN to the deployed origin (e.g. https://tutto.rzipas.win)
// in production to lock this down.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
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
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
