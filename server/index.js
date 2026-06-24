const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } = require('./database');
const { sanitizeStats } = require('./sanitize');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from dist/ if they exist
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 4000,
  pingTimeout: 6000
});

const PLAYER_COLORS = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33'
];

const rooms = {};

// Build a fresh, shuffled deck from a card-count config (Fisher-Yates).
const buildShuffledDeck = (initialCards) => {
  const deck = Object.keys(initialCards || {}).reduce((acc, card) => {
    for (let i = 0; i < initialCards[card]; i++) acc.push(card);
    return acc;
  }, []);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

// Draw the next card for a room, rebuilding/reshuffling the deck if exhausted.
const drawNextCardForRoom = (state) => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift();
  } else {
    const deck = buildShuffledDeck(state.initialCards);
    state.currentCard = deck.shift() || null;
    state.cards = deck;
  }
};

// Adjust turn ownership after a player is spliced out of the players array.
// `removedIdx` is the index the player occupied *before* removal.
const handleActivePlayerRemoved = (state, removedIdx) => {
  if (state.currentPlayerIndex === null) return;
  const curIdx = state.currentPlayerIndex;
  if (removedIdx < curIdx) {
    state.currentPlayerIndex = curIdx - 1;
  } else if (removedIdx === curIdx) {
    // The active player left mid-turn: hand the turn to the next player and
    // deal them a fresh card so they don't inherit the departed player's card.
    state.currentPlayerIndex = curIdx % Math.max(1, state.players.length);
    state.previousCard = null;
    state.previousScore = null;
    state.previousLeaders = null;
    state.round += 1;
    drawNextCardForRoom(state);
  }
};

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

    if (room.state.status !== 'lobby') {
      return callback({ error: 'Game is already running. You cannot join mid-game.' });
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
      
      const removedIdx = room.state.players.findIndex(p => p.socketId === targetSocketId);
      if (removedIdx !== -1) {
        room.state.players.splice(removedIdx, 1);
        handleActivePlayerRemoved(room.state, removedIdx);
      }
      emitRoomState(currentRoom);
      
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.leave(currentRoom);
      }
    }
  });

  // Whitelisted fields that the active player/host may advance
  const STATE_PUSH_WHITELIST = [
    'currentCard', 'cards', 'currentPlayerIndex', 'round',
    'finished', 'previousCard', 'previousScore', 'previousLeaders',
    'previousWasBust', 'previousHighestTurnScore',
    'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
    'status', 'winningScore', 'initialCards', 'randomOrder', 
    'turnDuration', 'reconnectTimeout',
    // Per-player mutable fields (arrays only — players array shape is preserved)
    'players',
  ];

  // Validates that the pushed players array is a same-length permutation of existing players
  // (same deviceIds, same order is not required, but no new players / no removals)
  const validatePushedPlayers = (existing, pushed) => {
    if (!Array.isArray(pushed) || pushed.length !== existing.length) return false;
    const existingIds = new Set(existing.map(p => p.deviceId));
    return pushed.every(p => existingIds.has(p.deviceId));
  };

  socket.on('pushState', ({ roomId, newState }) => {
    const room = rooms[roomId];
    if (!room || !newState || typeof newState !== 'object') return;

    // Only the host (start/end game, host-side turn-timer auto-bust) or the
    // player whose turn it currently is may push authoritative game state.
    // This is evaluated against the *current* (pre-push) state.
    const isHost = room.host === socket.id;
    const activePlayer = (room.state.currentPlayerIndex !== null && room.state.players)
      ? room.state.players[room.state.currentPlayerIndex]
      : null;
    const isActivePlayer = activePlayer && activePlayer.socketId === socket.id;

    if (!isHost && !isActivePlayer) return;

    // Merge only whitelisted fields
    for (const key of STATE_PUSH_WHITELIST) {
      if (!(key in newState)) continue;
      if (key === 'players') {
        if (!validatePushedPlayers(room.state.players, newState.players)) continue;
        // Only copy mutable game stats fields per player; never replace socketId, deviceId
        const PLAYER_MUTABLE = [
          'score', 'times1000PointsDeducted', 'timesKniffelCompleted',
          'timesPlusMinusCompleted', 'timesKniffelFailed', 'timesKleeblattFailed',
          'timesKleeblattCompleted', 'timesPlusMinusFailed', 'timesFeuerwerkReceived',
          'timesSkipped', 'timesx2Received', 'totalTurns', 'busts',
          'feuerwerkBusts', 'x2Busts', 'feuerwerkPointsScored', 'x2PointsScored',
          'highestTurnScore', 'position', 'color', 'disconnected',
        ];
        room.state.players = room.state.players.map(existing => {
          const pushed = newState.players.find(p => p.deviceId === existing.deviceId);
          if (!pushed) return existing;
          const updated = { ...existing };
          for (const f of PLAYER_MUTABLE) {
            if (f in pushed) updated[f] = pushed[f];
          }
          return updated;
        });
      } else {
        room.state[key] = newState[key];
      }
    }
    emitRoomState(roomId);
  });

  socket.on('endGameStats', async ({ deviceId, stats }) => {
    if (!deviceId) return;
    try {
      await updateDeviceStats(deviceId, sanitizeStats(stats));
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
          handleActivePlayerRemoved(room.state, playerIndex);

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
              const removedIdx = rooms[currentRoom].state.players.findIndex(p => p.deviceId === player.deviceId);
              if (removedIdx !== -1) {
                rooms[currentRoom].state.players.splice(removedIdx, 1);
                handleActivePlayerRemoved(rooms[currentRoom].state, removedIdx);

                if (rooms[currentRoom].state.players.length === 0) {
                  delete rooms[currentRoom];
                } else {
                  if (rooms[currentRoom].host === socket.id) {
                    rooms[currentRoom].host = rooms[currentRoom].state.players[0].socketId;
                  }
                  emitRoomState(currentRoom);
                }
              }
            }
          }, timeoutSecs * 1000);
        }
      }
    }
  };

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      socket.leave(currentRoom);
    }
    handlePlayerLeave(true);
    currentRoom = null;
    username = null;
  });

  socket.on('disconnect', () => {
    handlePlayerLeave(false);
  });
});

const API_TOKEN = process.env.TUTTO_API_TOKEN || 'tutto-local-dev-token';

const requireToken = (req, res, next) => {
  if (req.headers['x-tutto-token'] !== API_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

app.get('/api/stats/global', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    res.json(stats || {});
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/stats/global', requireToken, async (req, res) => {
  try {
    await updateGlobalStats(sanitizeStats(req.body));
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

app.post('/api/stats/:deviceId', requireToken, async (req, res) => {
  try {
    await updateDeviceStats(req.params.deviceId, sanitizeStats(req.body));
    res.json({ success: true });
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
