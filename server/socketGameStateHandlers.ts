import { rooms, emitRoomState, idleTurnTimerState, rememberCurrentTurn, roomChannel } from './rooms';
import { applyPushedState, isValidDiceSnapshot, sanitizeDiceSnapshot } from './pushValidation';
import { isNormalizedConfig } from '../src/utils/configValidation';
import { clearServerTurnTimer, startServerTurnTimer } from './turnTimers';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';

const PUSH_STATE_LIMIT = { windowMs: 1_000, max: 20 };
// liveTurnState fires ~every 300ms while a player is rolling.
const LIVE_TURN_STATE_LIMIT = { windowMs: 1_000, max: 15 };

// How many deck-triggered turn-timer restarts one player's turn may earn.
// A legitimate classic chain draws one card per continuation and even a
// full-deck chain stays far below this; a patched client pushing deck
// mutations to keep its own turn alive is cut off here and the deadline
// finally expires. Exported for the handler tests.
export const MAX_TIMER_RESTARTS_PER_TURN = 50;

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

    // Decided from the PRE-push status: once a game is running, a pushed
    // ruleset is refused (see applyPushedState) — a rules flip mid-game would
    // desync every client's turn logic. The game-starting push itself may
    // still carry it (it mirrors the lobby config it was started from).
    const allowRulesetWrite = startingGame || room.state.status === 'lobby';

    const applied = applyPushedState(room.state, newState, { isHost, startingGame, allowRulesetWrite });

    // Gated on the push having landed, and therefore only readable AFTER it:
    // applyPushedState discards a whole snapshot whose roster no longer
    // matches the server's, and clearing the dedup for a game that never
    // started let the host submit the still-finished game's statistics a
    // second time.
    if (startingGame && applied) {
      room.statsRecordedForGame = { devices: new Set(), global: false };
    }

    // Decided AFTER the push is applied: the opening push carries winningScore
    // and initialCards itself, so reading the pre-push state would see only the
    // lobby's config and miss a custom one smuggled in with the kickoff.
    //
    // Kickoff alone is not enough either. A host may push these two fields at
    // any time, mid-game included, so "start on the default config, shorten the
    // winning score once running, win in two turns" would otherwise be recorded
    // as a normal game. Hence the downgrade below — and it only ever goes one
    // way: pushing the defaults back before the end must not relabel the game.
    //
    // Gated on `applied` for the same reason as the dedup reset above: a
    // discarded push started no game, so re-deriving the label here would read
    // the STILL-finished game's current config and relabel its statistics
    // bucket — exactly the upgrade the sticky downgrade below exists to
    // prevent. The `else if` then keeps the downgrade running, which for an
    // unchanged state is a no-op.
    if (startingGame && applied) {
      room.normalizedGame = isNormalizedConfig(room.state);
      // Frozen for the same reason as normalizedGame: the stats handlers
      // must bucket by the rule set the game actually STARTED with, not by
      // whatever the state holds at submission time. No downgrade branch —
      // state.ruleset is immutable mid-game (see applyPushedState).
      room.ruleset = room.state.ruleset;
    } else if (room.state.status === 'playing') {
      room.normalizedGame &&= isNormalizedConfig(room.state);
    }

    // `!finished` matters as much as the status: a finished game KEEPS status
    // 'playing' all the way through the end screen, and its finishing push
    // already nulled gameActualStartTime after banking the elapsed time. So
    // without this, any later push against the finished room re-armed the
    // clock to now — and the finished branch below then recomputed
    // gameTimeInSeconds as now-minus-now = 0 and broadcast it, repainting
    // every end screen to 00:00. It also happens for a push that was
    // DISCARDED (a stale roster bails out of applyPushedState, but this
    // bookkeeping runs regardless), and a player who rejoins after that
    // broadcast then submits totalPlaytime: 0 to the stats.
    if (room.state.status === 'playing' && !room.state.finished && !room.gameActualStartTime) {
      room.gameActualStartTime = Date.now();
    }

    room.turnTimerState ??= idleTurnTimerState();

    // The card value is deliberately NOT a restart trigger: it cannot see a
    // classic mid-chain draw of the same card type (which must get a fresh
    // deadline — the deck shrinking is what reveals it), and it WAS a lever a
    // patched active player could flip back and forth to reset the deadline
    // indefinitely, defeating the server-authoritative expiry. Every
    // legitimate card change comes with a player change (nextTurn, undo,
    // kickoff) or a deck change (mid-chain draw, reshuffle). Deck-triggered
    // restarts are budgeted per turn — far above any real chain — so a
    // patched client pushing deck mutations is bounded too.
    const playerChanged = room.state.currentPlayerIndex !== room.turnTimerState.lastPlayerIndex;
    const deckChanged = room.state.cards.length !== room.turnTimerState.lastDeckSize;

    if (room.state.status === 'playing' && room.state.currentPlayerIndex !== null &&
        (playerChanged || (deckChanged && room.turnTimerState.restartsThisTurn < MAX_TIMER_RESTARTS_PER_TURN))) {
      room.state.turnStartTime = Date.now();
      const restartsBefore = room.turnTimerState.restartsThisTurn;
      rememberCurrentTurn(room);
      // Budgeted per TURN, so a deck-triggered restart carries the count on;
      // only a new player starts it over (which rememberCurrentTurn does).
      room.turnTimerState.restartsThisTurn = playerChanged ? 0 : restartsBefore + 1;
      startServerTurnTimer(io, roomId);
    }

    if (room.state.finished || room.state.status === 'lobby') {
      clearServerTurnTimer(roomId);
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
      }
      room.gameActualStartTime = null;
      room.turnTimerState = idleTurnTimerState();
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

    io.to(roomChannel(roomId)).emit('liveTurnState', { liveTurnState: room.state.liveTurnState });
  });
};
