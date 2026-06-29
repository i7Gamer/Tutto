require('dotenv').config({ path: path.join(__dirname, '../.env') });

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

const { PLAYER_COLORS } = require('../playerColors.json');

const VALID_CARD_TYPES = new Set([
  'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
]);
const MAX_CARD_COUNT = 99;

const validateInitialCards = (cards) => {
  if (typeof cards !== 'object' || cards === null) return false;
  const entries = Object.entries(cards);
  if (entries.length === 0) return false;
  return entries.every(([key, val]) =>
    VALID_CARD_TYPES.has(key) &&
    Number.isInteger(val) &&
    val >= 0 &&
    val <= MAX_CARD_COUNT
  );
};

// Fields only the host may push (game config + lifecycle).
const HOST_ONLY_FIELDS = new Set([
  'status', 'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout',
]);

// Fields the active player (or host) may push (turn-by-turn game state).
// 'finished' is intentionally here: the active player runs calculateNextTurn() locally
// and pushes the result (including finished=true) via pushState. Without this, a non-host
// player's game-ending turn (e.g. a Kleeblatt win) would never reach the server.
// This is a deliberate trust boundary — the server does not independently verify win
// conditions. Removing 'finished' would break game-over for non-host active players.
const ACTIVE_PLAYER_FIELDS = new Set([
  'currentCard', 'cards', 'currentPlayerIndex', 'round',
  'finished', 'previousCard', 'previousScore', 'previousLeaders',
  'previousWasBust', 'previousHighestTurnScore',
  'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
  'players', 'liveTurnState',
]);

// Pre-computed union used by the host path so we don't rebuild it on every pushState.
const ALL_FIELDS = new Set([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]);

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
  // Keep chartValues / chartNames in sync with the players array
  if (Array.isArray(state.chartValues) && removedIdx < state.chartValues.length) {
    state.chartValues.splice(removedIdx, 1);
  }
  if (Array.isArray(state.chartNames) && removedIdx < state.chartNames.length) {
    state.chartNames.splice(removedIdx, 1);
  }

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
    state.turnStartTime = Date.now();
    drawNextCardForRoom(state);
  }
};

const calculateGameTime = (room) => {
  if (!room.gameActualStartTime || room.state.status !== 'playing') {
    return room.state.gameTimeInSeconds;
  }
  return Math.floor((Date.now() - room.gameActualStartTime) / 1000);
};

const calculateRemainingTurnTime = (room) => {
  if (!room.state.turnStartTime || room.state.turnDuration === 0) {
    return null;
  }

  let multiplier = 1;
  if (room.state.currentCard === 'Feuerwerk') multiplier = 3;
  if (room.state.currentCard === 'Kleeblatt') multiplier = 2;
  const targetDuration = room.state.turnDuration * multiplier;

  const elapsedSeconds = Math.floor((Date.now() - room.state.turnStartTime) / 1000);
  return Math.max(0, targetDuration - elapsedSeconds);
};

const emitRoomState = (roomId) => {
  if (rooms[roomId]) {
    const room = rooms[roomId];
    const gameState = {
      ...room.state,
      turnTimeRemaining: calculateRemainingTurnTime(room),
      gameTimeInSeconds: calculateGameTime(room),
    };
    io.to(roomId).emit('gameState', gameState);
    // Also broadcast who the host is
    io.to(roomId).emit('hostId', rooms[roomId].host);
  }
};

const abortGameIfLowPlayers = (room, roomId) => {
  if (room.state.status === 'playing' && room.state.players.length < 2) {
    io.to(roomId).emit('gameAborted');
    room.state.status = 'lobby';
    room.state.currentCard = null;
    room.state.currentPlayerIndex = null;
    room.state.finished = false;
    return true;
  }
  return false;
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
          turnStartTime: null,
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

    if (room.state.players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      return callback({ error: 'Username already exists in this room' });
    }

    socket.join(roomId);
    currentRoom = roomId;
    username = name;

    const colorRe = /^#[0-9a-fA-F]{6}$/i;
    let assignedColor = color && colorRe.test(color) ? color : null;
    const usedColors = room.state.players.map(p => p.color);
    if (!assignedColor) {
      assignedColor = PLAYER_COLORS.find(c => !usedColors.includes(c));
    }
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
      if (typeof winningScore === 'number' && winningScore >= 1000 && winningScore <= 99999) rooms[roomId].state.winningScore = winningScore;
      if (validateInitialCards(initialCards)) rooms[roomId].state.initialCards = initialCards;
      if (typeof randomOrder === 'boolean') rooms[roomId].state.randomOrder = randomOrder;
      if (typeof turnDuration === 'number' && (turnDuration === 0 || (turnDuration >= 10 && turnDuration <= 600))) rooms[roomId].state.turnDuration = turnDuration;
      if (typeof reconnectTimeout === 'number' && (reconnectTimeout === 0 || (reconnectTimeout >= 10 && reconnectTimeout <= 3600))) rooms[roomId].state.reconnectTimeout = reconnectTimeout;
      emitRoomState(roomId);
    }
  });

  socket.on('reorderPlayers', ({ roomId, newPlayers }) => {
    if (rooms[roomId] && rooms[roomId].host === socket.id) {
      // Reordering is only meaningful before the game starts — prevent mid-game reshuffles
      if (rooms[roomId].state.status !== 'lobby') return;

      const currentNames = new Set(rooms[roomId].state.players.map(p => p.name));
      const newNames = new Set(newPlayers.map(p => p.name));
      const isPermutation =
        newPlayers.length === rooms[roomId].state.players.length &&
        currentNames.size === newNames.size &&
        newPlayers.every(p => currentNames.has(p.name));
        
      if (isPermutation) {
        // Reorder by mapping existing server-side objects; never trust client field values.
        rooms[roomId].state.players = newPlayers.map(np =>
          rooms[roomId].state.players.find(p => p.name === np.name)
        );
        rooms[roomId].state.randomOrder = false;
        emitRoomState(roomId);
      }
    }
  });

  socket.on('updatePlayerColor', ({ roomId, color }) => {
    if (rooms[roomId]) {
      const colorRe = /^#[0-9a-fA-F]{6}$/i;
      if (!color || !colorRe.test(color)) return;
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
      
      if (room.state.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        abortGameIfLowPlayers(room, currentRoom);
        emitRoomState(currentRoom);
      }

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.leave(currentRoom);
      }
    }
  });

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

    // Merge whitelisted fields; host-only fields are rejected for non-hosts.
    const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

    for (const key of allowedFields) {
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
        // NOTE: Do NOT add per-row score restrictions here (e.g. "non-host may
        // only update their own row"). The Plus_Minus card legitimately requires
        // the active non-host player to deduct 1000 pts from the leader's score
        // and to restore it on undo. A per-row filter silently discards those
        // changes and breaks the mechanic. Score integrity is enforced by the
        // game engine running on the active player's client, which is the same
        // engine the host runs — acceptable for a party game.
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

    // Record server-side game start time when game transitions to playing
    if (room.state.status === 'playing' && !room.gameActualStartTime) {
      room.gameActualStartTime = Date.now();
    }

    // Track turn changes and reset timer on new turn
    if (!room.turnTimerState) {
      room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
    }

    const cardChanged = room.state.currentCard !== room.turnTimerState.lastCard;
    const playerChanged = room.state.currentPlayerIndex !== room.turnTimerState.lastPlayerIndex;

    // Reset turn start time when card or player changes (new turn)
    if (room.state.status === 'playing' && room.state.currentPlayerIndex !== null && (cardChanged || playerChanged)) {
      room.state.turnStartTime = Date.now();
      room.turnTimerState.lastCard = room.state.currentCard;
      room.turnTimerState.lastPlayerIndex = room.state.currentPlayerIndex;
    }

    // Clear timers when game ends or returns to lobby
    if (room.state.finished || room.state.status === 'lobby') {
      room.state.turnStartTime = null;
      // Snapshot authoritative elapsed time before clearing the anchor so that
      // calculateGameTime's fallback returns the correct final value.
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
      }
      room.gameActualStartTime = null;
      if (room.turnTimerState) {
        room.turnTimerState.lastCard = null;
        room.turnTimerState.lastPlayerIndex = null;
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
            const nextHost = room.state.players.find(p => !p.disconnected);
            if (!nextHost) {
              // All remaining players are disconnected — close the room
              for (const p of room.state.players) {
                io.to(p.socketId).emit('kicked');
              }
              delete rooms[currentRoom];
              return;
            }
            room.host = nextHost.socketId;
          }
          abortGameIfLowPlayers(room, currentRoom);
          emitRoomState(currentRoom);
        } else {
          // Unexpected disconnect in-game
          player.disconnected = true;
          emitRoomState(currentRoom);
          io.to(currentRoom).emit('playerDisconnected', username);

          // Set kick timer
          if (!room.disconnectTimers) room.disconnectTimers = {};
          const timeoutSecs = room.state.reconnectTimeout ?? 60;
          if (timeoutSecs === 0) return; // disabled: player stays until manual kick
          const roomIdSnapshot = currentRoom;
          const hostSocketId = socket.id;

          room.disconnectTimers[player.deviceId] = setTimeout(() => {
            if (rooms[roomIdSnapshot]) {
              const removedIdx = rooms[roomIdSnapshot].state.players.findIndex(p => p.deviceId === player.deviceId);
              if (removedIdx !== -1) {
                rooms[roomIdSnapshot].state.players.splice(removedIdx, 1);
                handleActivePlayerRemoved(rooms[roomIdSnapshot].state, removedIdx);

                if (rooms[roomIdSnapshot].state.players.length === 0) {
                  delete rooms[roomIdSnapshot];
                } else {
                  if (rooms[roomIdSnapshot].host === hostSocketId) {
                    rooms[roomIdSnapshot].host = rooms[roomIdSnapshot].state.players[0].socketId;
                  }
                  abortGameIfLowPlayers(rooms[roomIdSnapshot], roomIdSnapshot);
                  emitRoomState(roomIdSnapshot);
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

if (process.env.NODE_ENV === 'production' && !process.env.VITE_API_TOKEN) {
  console.error('[SECURITY] VITE_API_TOKEN is not set. Refusing to start in production.');
  process.exit(1);
}
const API_TOKEN = process.env.VITE_API_TOKEN || 'tutto-local-dev-token';

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
    console.error("DB error in global GET:", err);
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
    console.error("DB error in device GET:", err);
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
  res.sendFile(path.join(__dirname, '../dist/index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
