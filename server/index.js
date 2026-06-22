const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from dist/ if they exist
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PLAYER_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33'
];

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

  socket.on('joinRoom', ({ roomId, name, deviceId, color }, callback) => {
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
          randomOrder: true,
          turnDuration: 120, // 0 means disabled
          reconnectTimeout: 60, // Default 1 minute
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
    
    // Reconnect logic
    const existingPlayer = room.state.players.find(p => p.deviceId === deviceId);
    if (existingPlayer) {
      // Re-claim this slot
      if (room.host === existingPlayer.socketId) {
        room.host = socket.id;
      }
      existingPlayer.socketId = socket.id;
      existingPlayer.name = name; // Update name just in case
      existingPlayer.disconnected = false;
      
      if (room.disconnectTimers && room.disconnectTimers[deviceId]) {
        clearTimeout(room.disconnectTimers[deviceId]);
        delete room.disconnectTimers[deviceId];
      }

      socket.join(roomId);
      currentRoom = roomId;
      username = name;
      
      callback({ success: true, isHost: room.host === socket.id, socketId: socket.id });
      emitRoomState(roomId);
      return;
    }

    if (room.state.players.find(p => p.name === name)) {
      return callback({ error: 'Username already exists in this room' });
    }

    socket.join(roomId);
    currentRoom = roomId;
    username = name;

    const usedColors = room.state.players.map(p => p.color);
    let assignedColor = color || PLAYER_COLORS.find(c => !usedColors.includes(c));
    if (!assignedColor) assignedColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];

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
      timesKleeblattCompleted: 0,
      timesPlusMinusFailed: 0,
      timesFeuerwerkReceived: 0,
      timesSkipped: 0,
      timesx2Received: 0,
      totalTurns: 0,
      busts: 0,
      feuerwerkBusts: 0,
      x2Busts: 0,
      feuerwerkPointsScored: 0,
      x2PointsScored: 0,
      position: 0,
      color: assignedColor,
      disconnected: false
    };
    room.state.players.push(newPlayer);
    
    callback({ success: true, isHost: room.host === socket.id, socketId: socket.id });
    emitRoomState(roomId);
  });

  socket.on('updateConfig', ({ roomId, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout }) => {
    if (rooms[roomId] && rooms[roomId].host === socket.id) {
      if (winningScore !== undefined) rooms[roomId].state.winningScore = winningScore;
      if (initialCards !== undefined) rooms[roomId].state.initialCards = initialCards;
      if (randomOrder !== undefined) rooms[roomId].state.randomOrder = randomOrder;
      if (turnDuration !== undefined) rooms[roomId].state.turnDuration = turnDuration;
      if (reconnectTimeout !== undefined) rooms[roomId].state.reconnectTimeout = reconnectTimeout;
      emitRoomState(roomId);
    }
  });

  socket.on('reorderPlayers', ({ roomId, newPlayers }) => {
    if (rooms[roomId] && rooms[roomId].host === socket.id) {
      rooms[roomId].state.players = newPlayers;
      rooms[roomId].state.randomOrder = false;
      emitRoomState(roomId);
    }
  });

  socket.on('updatePlayerColor', ({ roomId, color }) => {
    if (rooms[roomId]) {
      const player = rooms[roomId].state.players.find(p => p.socketId === socket.id);
      if (player) {
        player.color = color;
        emitRoomState(roomId);
      }
    }
  });

  socket.on('kickPlayer', (targetSocketId) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].host === socket.id) {
      const room = rooms[currentRoom];
      
      io.to(targetSocketId).emit('kicked');
      
      room.state.players = room.state.players.filter(p => p.socketId !== targetSocketId);
      emitRoomState(currentRoom);
      
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.leave(currentRoom);
      }
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

  const handlePlayerLeave = (isExplicitLeave = false) => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const playerIndex = room.state.players.findIndex(p => p.socketId === socket.id);
      
      if (playerIndex !== -1) {
        const player = room.state.players[playerIndex];

        if (isExplicitLeave) {
          // Permanently leave
          room.state.players.splice(playerIndex, 1);
          if (room.disconnectTimers && room.disconnectTimers[player.deviceId]) {
            clearTimeout(room.disconnectTimers[player.deviceId]);
            delete room.disconnectTimers[player.deviceId];
          }

          if (room.state.players.length === 0) {
            delete rooms[currentRoom];
            return;
          } else if (room.host === socket.id) {
            room.host = room.state.players[0].socketId;
          }
          emitRoomState(currentRoom);
        } else {
          // Unexpected disconnect in-game
          player.disconnected = true;
          emitRoomState(currentRoom);
          io.to(currentRoom).emit('playerDisconnected', username);

          // Set kick timer
          if (!room.disconnectTimers) room.disconnectTimers = {};
          const timeoutSecs = room.state.reconnectTimeout || 60;
          room.disconnectTimers[player.deviceId] = setTimeout(() => {
            if (rooms[currentRoom]) {
              rooms[currentRoom].state.players = rooms[currentRoom].state.players.filter(p => p.deviceId !== player.deviceId);
              if (rooms[currentRoom].state.players.length === 0) {
                delete rooms[currentRoom];
              } else {
                if (rooms[currentRoom].host === socket.id && rooms[currentRoom].state.players.length > 0) {
                  rooms[currentRoom].host = rooms[currentRoom].state.players[0].socketId;
                }
                emitRoomState(currentRoom);
              }
            }
          }, timeoutSecs * 1000);
        }
      }
    }
  };

  socket.on('leaveRoom', () => {
    handlePlayerLeave(true);
    socket.leave(currentRoom);
    currentRoom = null;
    username = null;
  });

  socket.on('disconnect', () => {
    handlePlayerLeave(false);
  });
});

app.get('/api/stats/global', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    res.json(stats || {});
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/stats/global', async (req, res) => {
  try {
    const stats = req.body;
    await updateGlobalStats(stats);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/stats/:deviceId', async (req, res) => {
  try {
    const stats = await getDeviceStats(req.params.deviceId);
    res.json(stats || {});
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
