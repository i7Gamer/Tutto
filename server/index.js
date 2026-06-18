const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { getDeviceStats, updateDeviceStats } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from dist/ if they exist
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const rooms = {};

const emitRoomState = (roomId) => {
  if (rooms[roomId]) {
    io.to(roomId).emit('gameState', rooms[roomId].state);
    // Also broadcast who the host is
    io.to(roomId).emit('hostId', rooms[roomId].host);
  }
};

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = null;

  socket.on('joinRoom', ({ roomId, name, deviceId }, callback) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        state: {
          players: [],
          status: 'lobby',
          initialCards: {
            Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5,
            Plus_Minus: 5, x2: 5, 200: 5, 300: 5, 400: 5, 500: 5, 600: 5,
          },
          winningScore: 6000,
          currentCard: null,
          cards: [],
          round: 1,
          currentPlayerIndex: null,
          finished: false,
          chartValues: [],
          chartNames: [],
          chartLabels: [],
          gameTimeInSeconds: 0,
          previousCard: null,
          previousScore: null,
          previousLeaders: null
        }
      };
    }

    const room = rooms[roomId];
    
    if (room.state.players.find(p => p.name === name)) {
      return callback({ error: 'Username already exists in this room' });
    }

    socket.join(roomId);
    currentRoom = roomId;
    username = name;

    const newPlayer = {
      name,
      deviceId,
      socketId: socket.id,
      score: 0,
      times1000PointsDeducted: 0,
      timesKniffelCompleted: 0,
      timesPlusMinusCompleted: 0,
      timesKniffelFailed: 0,
      timesKleeblattFailed: 0,
      timesPlusMinusFailed: 0,
      timesFeuerwerkReceived: 0,
      timesSkipped: 0,
      timesx2Received: 0,
      position: 0,
    };
    room.state.players.push(newPlayer);
    
    callback({ success: true, isHost: room.host === socket.id, socketId: socket.id });
    emitRoomState(roomId);
  });

  socket.on('updateConfig', ({ roomId, winningScore, initialCards }) => {
    if (rooms[roomId] && rooms[roomId].host === socket.id) {
      rooms[roomId].state.winningScore = winningScore;
      rooms[roomId].state.initialCards = initialCards;
      emitRoomState(roomId);
    }
  });

  socket.on('pushState', ({ roomId, newState }) => {
    if (rooms[roomId]) {
      rooms[roomId].state = newState;
      emitRoomState(roomId);
    }
  });

  socket.on('endGameStats', async ({ deviceId, stats }) => {
    try {
      await updateDeviceStats(deviceId, stats);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      // Note: We don't remove players on disconnect during a game, to allow reconnecting!
      // But for simplicity in this version, if lobby, we remove them.
      if (room.state.status === 'lobby') {
        room.state.players = room.state.players.filter(p => p.socketId !== socket.id);
        if (room.state.players.length === 0) {
          delete rooms[currentRoom];
        } else if (room.host === socket.id) {
          room.host = room.state.players[0].socketId;
          emitRoomState(currentRoom);
        } else {
          emitRoomState(currentRoom);
        }
      } else {
        // If playing, we just notify they disconnected, but keep them in state
        io.to(currentRoom).emit('playerDisconnected', username);
      }
    }
  });
});

app.get('/api/stats/:deviceId', async (req, res) => {
  try {
    const stats = await getDeviceStats(req.params.deviceId);
    res.json(stats || {});
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
