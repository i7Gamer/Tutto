import { rooms, drawNextCardForRoom, emitRoomState, emitRoomStateTo, idleTurnTimerState, recordDealtCard, rememberCurrentTurn, roomChannel } from './rooms';
import { isValidDiceSnapshot, sanitizeDiceSnapshot } from './pushValidation';
import { applyOnlineGameAction } from './gameActionAuthority';
import { readDeckContext, settleDeck } from './deckAuthority';
import { isNormalizedConfig, normalizeRoomId, MAX_PLAYERS_PER_ROOM } from '../src/utils/configValidation';
import { roomPhase } from '../src/utils/roomPhase';
import { MS_PER_SECOND } from '../src/utils/time';
import { clearServerTurnTimer, startServerTurnTimer } from './turnTimers';
import { createSocketEventLimiter, createObjectWorkBudget } from './rateLimit';
import { envLimitOr } from './envLimits';
import { safeOn, type SocketContext } from './socketContext';
import { MAX_CHAIN_CARDS, type DrawCardAck, type DrawRefusalReason, type PushRefusalReason, type PushStateAck } from '../src/types';
import { randomUUID } from 'node:crypto';

// UUIDs are correlation identities, not credentials. Authorization remains below.
const GAMEPLAY_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUSH_STATE_LIMIT = { windowMs: 1_000, max: 20 };
export const ROOM_PUSH_WORK_LIMIT = { windowMs: 1_000, max: MAX_PLAYERS_PER_ROOM };
const roomWorkBudgets = new WeakMap<SocketContext['io'], ReturnType<typeof createObjectWorkBudget>>();
// liveTurnState fires ~every 300ms while a player is rolling.
const LIVE_TURN_STATE_LIMIT = { windowMs: 1_000, max: 15 };
// requestState is a client's recovery path after a refused push — one round
// trip, not a stream. Bounded well above any real burst (a reconnect storm on
// one socket) and far below anything that could be used to make the server
// re-serialize a room in a loop.
const REQUEST_STATE_LIMIT = { windowMs: 1_000, max: 5 };
// A chain draw follows a tutto, which follows at least one roll and a reveal
// the player has to dismiss — seconds apart at the very fastest. Anything at
// this rate is a client walking the deck, and each call re-serializes and
// broadcasts the whole room. Exported for this file's own tests.
export const DRAW_CARD_LIMIT = { windowMs: 1_000, max: 5 };

/**
 * The optional callback a client may pass as pushState's second argument.
 *
 * Optional in the type as well as on the wire: a client predating the ack
 * sends only the payload, socket.io then invokes the handler with one
 * argument, and everything below behaves exactly as it did before.
 */
type PushStateAckFn = (result: PushStateAck) => void;

/** drawCard's direct answer; a correlated gameState receipt is the recovery path. */
type DrawCardAckFn = (result: DrawCardAck) => void;

// How many card-triggered turn-timer restarts one player's turn may earn.
// A legitimate classic chain draws one card per continuation and even a
// full-deck chain stays far below this; a patched client drawing in a loop to
// keep its own turn alive is cut off here and the deadline finally expires.
// Exported for the handler tests.
export const MAX_TIMER_RESTARTS_PER_TURN = 50;

/** The authoritative game state, and the live dice view that rides alongside it. */
export const registerGameStateHandlers = ({ io, socket, session }: SocketContext): void => {
  let roomWorkBudget = roomWorkBudgets.get(io);
  if (!roomWorkBudget) {
    roomWorkBudget = createObjectWorkBudget({ ...ROOM_PUSH_WORK_LIMIT,
      max: envLimitOr(process.env.ROOM_PUSH_WORK_LIMIT_MAX, ROOM_PUSH_WORK_LIMIT.max) });
    roomWorkBudgets.set(io, roomWorkBudget);
  }
  const pushStateLimiter = createSocketEventLimiter(PUSH_STATE_LIMIT);
  const liveTurnStateLimiter = createSocketEventLimiter(LIVE_TURN_STATE_LIMIT);
  const requestStateLimiter = createSocketEventLimiter(REQUEST_STATE_LIMIT);
  const drawCardLimiter = createSocketEventLimiter(DRAW_CARD_LIMIT);

  safeOn(socket, 'pushState', (
    data: { roomId?: string; newState?: Record<string, unknown>; base?: unknown; mutationId?: unknown; action?: unknown } | null | undefined,
    ack?: PushStateAckFn,
  ) => {
    // Every bail-out below now names itself to the sender. The gates
    // themselves are unchanged — a refused push is still applied nowhere and
    // still broadcasts nothing; the client just stops having to infer that
    // from a broadcast that may never come.
    const refuse = (reason: PushRefusalReason): void => {
      if (typeof ack === 'function') ack({ ok: false, reason });
    };

    if (!pushStateLimiter()) return refuse('rate-limited');
    if (!data || typeof data !== 'object') return refuse('refused');
    const { roomId: rawRoomId, newState } = data;
    if (typeof rawRoomId !== 'string' || !newState || typeof newState !== 'object') return refuse('refused');
    // Same normalization joinRoom applies before ever touching `rooms`.
    const roomId = normalizeRoomId(rawRoomId);
    const room = rooms[roomId];
    if (!room) return refuse('no-room');

    const isHost = room.host === socket.id;
    const activePlayer = room.state.currentPlayerIndex !== null
      ? room.state.players[room.state.currentPlayerIndex]
      : null;
    const isActivePlayer = activePlayer?.socketId === socket.id;

    // Also what a push that overtook its own sender's rejoin looks like: the
    // seat still carries the socket id of the connection that died. The client
    // retries such a refusal once (see emitPushState in socketSlice.ts) rather
    // than the seat being loosened here.
    if (!isHost && !isActivePlayer) return refuse('unauthorized');
    if (!roomWorkBudget.tryConsume(room)) return refuse('rate-limited');
    // Charge authorized attempts before deep or stale validation, including
    // malformed/no-op spam. Unauthorized sockets cannot exhaust this budget.
    if (typeof data.base !== 'string' || !GAMEPLAY_TOKEN_PATTERN.test(data.base) ||
        typeof data.mutationId !== 'string' || !GAMEPLAY_TOKEN_PATTERN.test(data.mutationId) ||
        data.mutationId === data.base) return refuse('refused');
    if (data.base !== room.gameplayToken) return refuse('stale-base');

    // Start/rematch is an explicit host action; the server selects the order.
    const currentPhase = roomPhase(room.state);
    const startingGame = isHost && !!data.action && typeof data.action === 'object' &&
      (data.action as { type?: unknown }).type === 'start';

    // Capture the private deck before applying the action so advancement and
    // undo can use the server's deal ledger.
    const deckBefore = readDeckContext(room.state);
    const roundBefore = room.state.round;

    const applied = applyOnlineGameAction(room, data.action, socket.id);
    if (!applied) return refuse('refused');

    const startedGame = startingGame && applied && roomPhase(room.state) !== currentPhase;

    // Only an accepted start resets accounting for the next game.
    if (startedGame) {
      room.statsRecordedForGame = { devices: new Map(), global: false };
      room.participantStats = new Map();
      // The only record of who was actually at the table when THIS game
      // began — a seat that leaves, is kicked, or times out before the
      // finish is broadcast is spliced out of room.state.players by then, and
      // this is what lets recordDepartedSeatsStats (rooms.ts) still find it.
      room.startRoster = room.state.players.map(p => ({ deviceId: p.deviceId, name: p.name }));
    }

    // Freeze statistics configuration at kickoff; later changes can only
    // downgrade normalized status, never relabel a custom game as default.
    if (startedGame) {
      room.normalizedGame = isNormalizedConfig(room.state);
      // Frozen for the same reason as normalizedGame: the stats handlers
      // must bucket by the rule set the game actually STARTED with, not by
      // whatever the state holds at submission time. No downgrade branch —
      // state.ruleset is immutable mid-game.
      room.ruleset = room.state.ruleset;
    } else if (room.state.status === 'playing') {
      room.normalizedGame &&= isNormalizedConfig(room.state);
    }

    // A finished room still has status 'playing'; do not restart its clock.
    if (roomPhase(room.state) === 'playing' && !room.gameActualStartTime) {
      room.gameActualStartTime = Date.now();
    }

    // The deck move this push implies, dealt by the server — the push itself
    // can no longer write `cards` or `currentCard` at all (see
    // server/deckAuthority.ts). Before the timer bookkeeping below, so a card
    // dealt here gets its deadline in the same pass, and before emitRoomState,
    // so it rides the same broadcast as the turn it belongs to.
    settleDeck(room, deckBefore, startedGame);

    room.turnTimerState ??= idleTurnTimerState();

    // The card value is deliberately NOT a restart trigger: it WAS a lever a
    // patched active player could flip back and forth to reset the deadline
    // indefinitely, defeating the server-authoritative expiry. Every
    // legitimate card change now comes with a player change (nextTurn, undo,
    // kickoff), because those are the only pushes settleDeck deals for; a
    // mid-chain draw takes the drawCard path below and restarts its own clock.
    // The deck clause is kept as the backstop for any future server-side deal
    // during a push that does NOT move the seat — budgeted per turn, far above
    // any real chain, so it cannot become a way to hold a turn open.
    const playerChanged = room.state.currentPlayerIndex !== room.turnTimerState.lastPlayerIndex;
    const deckChanged = room.state.cards.length !== room.turnTimerState.lastDeckSize;
    const turnBoundary = playerChanged || room.state.round !== roundBefore || startedGame;

    if (applied && turnBoundary) room.state.liveTurnState = null;

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

    if (roomPhase(room.state) !== 'playing') {
      clearServerTurnTimer(roomId);
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / MS_PER_SECOND);
      }
      room.gameActualStartTime = null;
      room.turnTimerState = idleTurnTimerState();
    }

    // Acceptance advances lineage; presence-only broadcasts do not.
    room.gameplayToken = data.mutationId;
    emitRoomState(io, roomId);

    // Report the canonical broadcast's identity, never the discarded snapshot.
    if (typeof ack === 'function') {
      ack({ ok: true, stateVersion: room.stateVersion, gameplayToken: room.gameplayToken });
    }
  });

  /**
   * "I have committed to drawing — deal me the next card."
   *
   * The classic chain's mid-turn draw. It used to be a local shift off the
   * client's own copy of `cards` (gameSlice.drawCardMidTurn), pushed back as a
   * fait accompli — which is precisely the decision that cannot be left with
   * anything holding the deck, because the whole of a classic turn is "bank
   * what you have, or reveal the next card and risk it". Asking the server
   * afterwards is what makes the card unknowable at the moment of the choice.
   *
   * The ACTIVE player only, and unlike pushState the host is NOT exempt. There
   * is no legitimate reason for another seat to spend a card off the deck, and
   * the cost lands on the victim: their card is burnt and their turn clock is
   * restarted underneath them.
   */
  safeOn(socket, 'drawCard', (
    data: { roomId?: string; base?: unknown; drawId?: unknown } | null | undefined,
    ack?: DrawCardAckFn,
  ) => {
    const answer = (result: DrawCardAck): void => {
      if (typeof ack === 'function') ack(result);
    };
    const refuse = (reason: DrawRefusalReason): void => answer({ ok: false, reason });

    if (!data || typeof data !== 'object') return refuse('refused');
    const { roomId: rawRoomId } = data;
    if (typeof rawRoomId !== 'string') return refuse('refused');
    // Same normalization joinRoom applies before ever touching `rooms`.
    const roomId = normalizeRoomId(rawRoomId);
    const room = rooms[roomId];
    if (!room) return refuse('no-room');

    // roomPhase, not the status field: a won game is still status 'playing'
    // (see roomPhase), and dealing into it would put a card back on an end
    // screen and re-arm a turn nobody is taking.
    if (roomPhase(room.state) !== 'playing' || room.state.currentPlayerIndex === null) {
      return refuse('not-playing');
    }
    const activePlayer = room.state.players[room.state.currentPlayerIndex];
    if (activePlayer?.socketId !== socket.id) {
      return refuse('unauthorized');
    }
    if (typeof data.base !== 'string' || !GAMEPLAY_TOKEN_PATTERN.test(data.base) ||
        typeof data.drawId !== 'string' || !GAMEPLAY_TOKEN_PATTERN.test(data.drawId)) return refuse('refused');

    // The first deal may have reached the room while only its callback packet
    // was lost. Re-answer that exact device/request/base tuple while the deal's
    // lineage is still current; never spend another card for a retry.
    const receipt = room.acceptedDraw;
    if (receipt && receipt.drawId === data.drawId && receipt.deviceId === activePlayer.deviceId &&
        receipt.base === data.base && receipt.gameplayToken === room.gameplayToken) {
      return answer({ ok: true, card: receipt.card });
    }

    if (!drawCardLimiter()) return refuse('rate-limited');
    if (data.base !== room.gameplayToken) return refuse('refused');
    if (room.state.ruleset !== 'classic') return refuse('refused');
    if (room.dealtThisTurn.length >= MAX_CHAIN_CARDS) return refuse('refused');
    // These cards end their turn rather than continuing a chain.
    if (room.state.currentCard === 'Stop' || room.state.currentCard === 'Kleeblatt' ||
        room.state.currentCard === 'Feuerwerk') return refuse('refused');

    drawNextCardForRoom(room.state);
    const card = room.state.currentCard;
    // drawNextCardForRoom rebuilds an exhausted deck before dealing, so this
    // is null only for a room configured with no cards at all — which
    // validateInitialCards refuses SERVER-side before such a game can start.
    // (Both lobbies also gate the start button on hasPlayableDeck, but that is
    // a client check and cannot be what this guard rests on.)
    if (!card) return refuse('not-playing');
    // Extends the turn already in progress rather than opening one, so this
    // card joins the current turn's list — an undo of this turn gives it back.
    recordDealtCard(room, card, false);

    // The fresh card is a fresh deadline: without this a chain drawn late in a
    // turn inherits whatever seconds the previous card had left. Budgeted by
    // the same per-turn count pushState's own restarts spend, so a client
    // drawing in a loop to hold its turn open runs out and expires — the
    // budget that used to bound the same abuse arriving as a pushed deck.
    room.turnTimerState ??= idleTurnTimerState();
    if (room.turnTimerState.restartsThisTurn < MAX_TIMER_RESTARTS_PER_TURN) {
      const restartsBefore = room.turnTimerState.restartsThisTurn;
      room.state.turnStartTime = Date.now();
      rememberCurrentTurn(room);
      room.turnTimerState.restartsThisTurn = restartsBefore + 1;
      startServerTurnTimer(io, roomId);
    } else {
      // Still record the deal, or the next pushState reads the shrunken deck
      // as a change of its own and hands back the restart just refused here.
      rememberCurrentTurn(room);
      room.turnTimerState.restartsThisTurn = MAX_TIMER_RESTARTS_PER_TURN;
    }

    // Broadcast BEFORE the ack: every other client has to see the same chain
    // the drawer is about to roll on, and the drawer's own gameState carries
    // the card as well — the ack is what lets it act without waiting.
    room.gameplayToken = randomUUID();
    room.acceptedDraw = {
      drawId: data.drawId, deviceId: activePlayer.deviceId, base: data.base,
      card, gameplayToken: room.gameplayToken,
    };
    emitRoomState(io, roomId);
    answer({ ok: true, card });
  });

  /**
   * "Send me the room as it is now" — answered to this socket alone.
   *
   * The recovery path for a client whose push was refused: it can no longer
   * trust what it is rendering, and the room may not broadcast again for a
   * whole turn. Read-only, so it does not advance the state version (see
   * emitRoomStateTo) and a client that asks is not penalised with a state its
   * own floor would then drop.
   *
   * Gated on a LIVE SEAT, not on a client-supplied membership claim — and not
   * on `session.roomId` alone either, the way sendReaction and updatePlayerColor
   * resolve their own senders. Nothing clears a ConnectionSession when a socket
   * loses its seat: kickPlayer (socketRosterHandlers) splices the player and
   * tells the socket to leave the channel, and the same-device takeover in
   * joinRoom (socketRoomHandlers) does the same to the superseded connection —
   * both leave `session.roomId` still naming the room. A session check alone
   * therefore let a kicked or superseded socket keep pulling the whole live
   * gameState (roster, scores, every seat's socketId) at the limiter's five
   * calls a second, for as long as it stayed connected. The seat lookup is the
   * thing those two paths actually revoke.
   */
  safeOn(socket, 'requestState', (data: { roomId?: string; requestId?: unknown } | null | undefined) => {
    if (!requestStateLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId } = data;
    if (typeof rawRoomId !== 'string') return;
    // Same normalization joinRoom applies before ever touching `rooms` —
    // session.roomId is already canonical (set there), so this keeps the
    // comparison correct regardless of what case the client happens to send.
    const roomId = normalizeRoomId(rawRoomId);
    if (session.roomId !== roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    if (!room.state.players.some(p => p.socketId === socket.id)) return;
    const requestId = typeof data.requestId === 'string' && GAMEPLAY_TOKEN_PATTERN.test(data.requestId)
      ? data.requestId
      : undefined;
    emitRoomStateTo(socket, roomId, requestId ? { stateRequestId: requestId } : undefined);
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
  safeOn(socket, 'liveTurnState', (data: { roomId?: string; base?: unknown; liveTurnState?: unknown } | null | undefined) => {
    if (!liveTurnStateLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId, liveTurnState } = data;
    if (typeof rawRoomId !== 'string') return;
    // Same normalization joinRoom applies before ever touching `rooms`.
    const roomId = normalizeRoomId(rawRoomId);
    const room = rooms[roomId];
    if (!room) return;

    const activePlayer = room.state.currentPlayerIndex !== null
      ? room.state.players[room.state.currentPlayerIndex]
      : null;
    const isActivePlayer = activePlayer?.socketId === socket.id;

    // The ACTIVE player alone, unlike pushState's `isHost || isActivePlayer`.
    // The host has no live turn of its own to relay while someone else is
    // rolling, and this snapshot is not just a spectator view: turnTimers
    // reads it into the timed-out player's OWN highestForfeitedTurnScore,
    // which their unmodified client then submits for their device — where the
    // DB merges it with MAX, permanently. So a host could plant a record on a
    // victim, or wipe the snapshot the room is watching, on a turn that is not
    // theirs. Nothing legitimate emits this as a non-active host: the physical
    // relay is gated on isMyTurn and the dice modal is force-closed for every
    // non-active client.
    if (!isActivePlayer) return;
    if (roomPhase(room.state) !== 'playing' || data.base !== room.gameplayToken) return;

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
