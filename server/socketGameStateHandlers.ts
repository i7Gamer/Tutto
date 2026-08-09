import { rooms, emitRoomState } from './rooms';
import { applyPushedState, isValidDiceSnapshot, sanitizeDiceSnapshot } from './pushValidation';
import { isNormalizedConfig } from '../src/utils/configValidation';
import { clearServerTurnTimer, startServerTurnTimer } from './turnTimers';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';

const PUSH_STATE_LIMIT = { windowMs: 1_000, max: 20 };
// liveTurnState fires ~every 300ms while a player is rolling.
const LIVE_TURN_STATE_LIMIT = { windowMs: 1_000, max: 15 };

/** The authoritative game state, and the live dice view that rides alongside it. */
export const registerGameStateHandlers = ({ io, socket }: SocketContext): void => {
  const pushStateLimiter = createSocketEventLimiter(PUSH_STATE_LIMIT);
  const liveTurnStateLimiter = createSocketEventLimiter(LIVE_TURN_STATE_LIMIT);

  safeOn(socket, 'pushState', (data: { roomId?: string; newState?: Record<string, unknown> } | null | undefined) => {
    if (!pushStateLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId, newState } = data;
    if (typeof roomId !== 'string' || !newState || typeof newState !== 'object') return;
    const room = rooms[roomId];
    if (!room) return;

    const isHost = room.host === socket.id;
    const activePlayer = room.state.currentPlayerIndex !== null
      ? room.state.players[room.state.currentPlayerIndex]
      : null;
    const isActivePlayer = activePlayer?.socketId === socket.id;

    if (!isHost && !isActivePlayer) return;

    // The host may legitimately reorder players (e.g. the random shuffle) only at
    // the moment the game starts. Outside that transition the server keeps its own
    // authoritative order so a stray push can never scramble the roster mid-game.
    // A game starts either from the lobby, or from the end screen's "Play Again",
    // which never passes through the lobby: the room is still status 'playing'
    // with finished=true when the host pushes the next game's opening state.
    const startingGame = isHost && newState.status === 'playing' &&
      (room.state.status === 'lobby' || (room.state.finished && newState.finished === false));
    if (startingGame) {
      room.statsRecordedForGame = { devices: new Set(), global: false };
    }

    // Decided from the PRE-push status: once a game is running, a pushed
    // ruleset is refused (see applyPushedState) — a rules flip mid-game would
    // desync every client's turn logic. The game-starting push itself may
    // still carry it (it mirrors the lobby config it was started from).
    const allowRulesetWrite = startingGame || room.state.status === 'lobby';

    applyPushedState(room.state, newState, { isHost, startingGame, allowRulesetWrite });

    // Decided AFTER the push is applied: the opening push carries winningScore
    // and initialCards itself, so reading the pre-push state would see only the
    // lobby's config and miss a custom one smuggled in with the kickoff.
    //
    // Kickoff alone is not enough either. A host may push these two fields at
    // any time, mid-game included, so "start on the default config, shorten the
    // winning score once running, win in two turns" would otherwise be recorded
    // as a normal game. Hence the downgrade below — and it only ever goes one
    // way: pushing the defaults back before the end must not relabel the game.
    if (startingGame) {
      room.normalizedGame = isNormalizedConfig(room.state);
      // Frozen for the same reason as normalizedGame: the stats handlers
      // must bucket by the rule set the game actually STARTED with, not by
      // whatever the state holds at submission time. No downgrade branch —
      // state.ruleset is immutable mid-game (see applyPushedState).
      room.ruleset = room.state.ruleset;
    } else if (room.state.status === 'playing') {
      room.normalizedGame &&= isNormalizedConfig(room.state);
    }

    if (room.state.status === 'playing' && !room.gameActualStartTime) {
      room.gameActualStartTime = Date.now();
    }

    if (!room.turnTimerState) {
      room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
    }

    const cardChanged = room.state.currentCard !== room.turnTimerState.lastCard;
    const playerChanged = room.state.currentPlayerIndex !== room.turnTimerState.lastPlayerIndex;

    if (room.state.status === 'playing' && room.state.currentPlayerIndex !== null && (cardChanged || playerChanged)) {
      room.state.turnStartTime = Date.now();
      room.turnTimerState.lastCard = room.state.currentCard;
      room.turnTimerState.lastPlayerIndex = room.state.currentPlayerIndex;
      startServerTurnTimer(io, roomId);
    }

    if (room.state.finished || room.state.status === 'lobby') {
      clearServerTurnTimer(roomId);
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
      }
      room.gameActualStartTime = null;
      if (room.turnTimerState) {
        room.turnTimerState.lastCard = null;
        room.turnTimerState.lastPlayerIndex = null;
      }
    }

    emitRoomState(io, roomId);
  });

  // Dedicated low-overhead path for live dice-roll updates (fired ~every
  // 300ms while a player is rolling). Deliberately separate from pushState:
  // that handler re-serializes and broadcasts the ENTIRE room snapshot
  // (players, historyLog, chart arrays, ...) on every call via
  // emitRoomState, which is wasteful for an update where only
  // liveTurnState actually changed. This handler updates just that one
  // field and broadcasts a small, standalone event instead — pushState,
  // applyPushedState, and emitRoomState are untouched and still carry
  // liveTurnState as part of the full sync for reconnect/fresh-join.
  safeOn(socket, 'liveTurnState', (data: { roomId?: string; liveTurnState?: unknown } | null | undefined) => {
    if (!liveTurnStateLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId, liveTurnState } = data;
    if (typeof roomId !== 'string') return;
    const room = rooms[roomId];
    if (!room) return;

    const isHost = room.host === socket.id;
    const activePlayer = room.state.currentPlayerIndex !== null
      ? room.state.players[room.state.currentPlayerIndex]
      : null;
    const isActivePlayer = activePlayer?.socketId === socket.id;

    if (!isHost && !isActivePlayer) return;

    if (liveTurnState === null) {
      room.state.liveTurnState = null;
    } else if (isValidDiceSnapshot(liveTurnState)) {
      room.state.liveTurnState = sanitizeDiceSnapshot(liveTurnState);
    } else {
      return;
    }

    io.to(roomId).emit('liveTurnState', { liveTurnState: room.state.liveTurnState });
  });
};
