import { localStore, sessionStore } from '../utils/storage';
import { io, type Socket } from 'socket.io-client';
import { buildDeviceStatsPayload, noUndoableTurn } from '../utils/coreGameEngine';
import i18n from '../i18n';
import { areInitialCardsEqual } from '../utils/configValidation';
import { validateOnlineConfig } from './persistence';
import { getSocket, setSocket } from './socketRef';
import { REACTION_DISPLAY_MS } from '../utils/reactions';
import { SYNCED_GAME_STATE_KEYS } from '../types';
import type { Reaction, DiceSnapshot, AssertNever, SyncedGameStateKey, PushStateAck } from '../types';
import type { GameStore, JoinRoomResponse, ConfigKeys, ImmerStateCreator } from './storeTypes';
import { finishedGameSnapshotOf, makeToast } from './gameSlice';
import { clearTurnCaches } from '../utils/diceTurnState';
import { joinErrorMessage } from '../utils/joinErrors';
import { JOIN_TIMEOUT_MS, PUSH_REJOIN_RACE_WINDOW_MS, PUSH_REJOIN_RETRY_DELAY_MS } from '../utils/uiTimings';

type SocketSlice = Pick<GameStore,
  | 'connectSocket' | 'joinRoom' | 'leaveRoom' | 'kickPlayer'
  | 'cancelReconnect' | 'pushState' | 'pushLiveTurnState' | 'sendOnlineStats'
>;

// Shared by every path that abandons the current online room (leaveRoom, the
// 'kicked' handler, cancelReconnect, and useGameStore's reset) so these
// ~12 room-identity/game fields can't drift out of sync between them the
// way they were previously duplicated as separate hand-written literals.
// Fields the server's 'gameState' broadcast is allowed to overwrite on the
// client store — the canonical SYNCED_GAME_STATE_KEYS (src/types.ts), which
// server/roomTypes.ts locks against RoomState, the authoritative game state
// the server actually spreads into that payload. Without this allowlist,
// Object.assign(prev, serverState) would apply every key a (compromised or
// buggy) server sends, including store action functions like
// startGame/sendOnlineStats, since serverState is typed as Partial<GameStore>.
// The satisfies is the lock's client half: every synced key is a real store field.
export const GAME_STATE_SYNC_KEYS = SYNCED_GAME_STATE_KEYS satisfies readonly (keyof GameStore)[];

export const clearRoomState = (): Pick<GameStore,
  | 'players' | 'currentPlayerIndex' | 'currentCard' | 'cards' | 'round' | 'finished'
  | 'status' | 'roomId' | 'isHost' | 'hostId' | 'myName' | 'liveTurnState'
  | 'turnTimeRemaining' | 'turnDeadline'
  | 'chartValues' | 'chartNames' | 'chartLabels' | 'historyLog'
  | 'previousCard' | 'previousScore' | 'previousLeaders' | 'previousWasBust'
  | 'previousWasSuccess' | 'previousHighestTurnScore'
  | 'previousHighestFeuerwerkTurnScore' | 'previousHighestX2TurnScore'
  | 'previousPlayerName' | 'previousTurnSummary' | 'finishedGameSnapshot'
  | 'lastAppliedStateVersion'
> => ({
  players: [],
  currentPlayerIndex: null,
  currentCard: null,
  cards: [],
  round: 1,
  finished: false,
  status: 'lobby',
  roomId: null,
  isHost: false,
  hostId: null,
  myName: null,
  liveTurnState: null,
  // Only online rooms have a turn timer, and stopOnlineTimers clears the
  // interval without clearing the value it was counting down — Scoreboard
  // renders its tile from this alone, so an abandoned room's countdown sat
  // frozen inside a local game.
  turnTimeRemaining: null,
  // Client-derived, like turnTimeRemaining above — an abandoned room's
  // deadline must not survive into the next local/online game either.
  turnDeadline: null,
  // The rest of the abandoned game, not just who was at the table. These are
  // per-game, so leaving them behind is the same bleed the roster used to
  // cause: setMode('local') only overwrites the keys a saved local game
  // happens to contain, so with no save (or one predating a key) the online
  // room's chart series and activity log survive into local mode — and the
  // local persistence subscriber then writes them to disk. The undo block is
  // the sharp one: Game.tsx's hasUndoableTurn reads previousCard/
  // previousPlayerName, so a live Undo button was offered for a turn played
  // in a room this client had already left.
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  historyLog: [],
  // The finished game goes with the room it was played in.
  finishedGameSnapshot: null,
  // Versions are per-room and start over at zero in a freshly created room, so
  // a floor carried out of the room just left would make the next room's whole
  // opening sequence look stale and be ignored.
  lastAppliedStateVersion: null,
  ...noUndoableTurn(),
});

// The other half of clearRoomState's contract, enforced at compile time:
// every synced game-state field must either be cleared above or be named here
// as deliberately surviving a leave. A new field filed in neither refuses to
// build instead of silently bleeding from an abandoned room into local play.
type FieldKeptOnLeave =
  // Room config: the next lobby deliberately reopens with the same settings.
  | 'initialCards' | 'winningScore' | 'randomOrder' | 'turnDuration'
  | 'reconnectTimeout' | 'ruleset'
  // Every read is gated on isOnline (Game.tsx's effectiveDiceMode, the online
  // lobbies), so a value left behind is inert until the next room's first
  // sync replaces it.
  | 'enforcedDiceMode'
  // startGame resets it to 0 before anything can read it again — nothing
  // renders it while status is 'lobby'.
  | 'gameTimeInSeconds';

// Exported only so noUnusedLocals sees a use; nothing imports it. Each tuple
// element must be `never`, or the build fails naming the offending key.
export type ClearRoomStateLock = [
  // Every synced field is either cleared or deliberately kept.
  AssertNever<Exclude<SyncedGameStateKey, keyof ReturnType<typeof clearRoomState> | FieldKeptOnLeave>>,
  // No field is both kept and cleared.
  AssertNever<Extract<keyof ReturnType<typeof clearRoomState>, FieldKeptOnLeave>>,
  // The kept list holds only real synced fields (typo guard).
  AssertNever<Exclude<FieldKeptOnLeave, SyncedGameStateKey>>,
];

// Tracks the in-flight cancelReconnect attempt (if any) so a second rapid
// call cancels the first's throwaway socket instead of leaving it dangling
// alongside a new one.
let pendingCancelReconnectCleanup: (() => void) | null = null;

/** The exact bytes pushState puts on the wire — see the action at the bottom. */
interface PushStatePayload {
  roomId: string | null;
  newState: Record<SyncedGameStateKey, unknown>;
}

/**
 * The one push that could not be sent, held until this client's rejoin lands.
 *
 * socket.io-client would happily buffer the emit itself — and that is the bug.
 * Its Socket#onconnect flushes the send buffer BEFORE it fires 'connect', so a
 * buffered push arrives on the NEW socket id while the seat still carries the
 * old one. The server (which has no connection-state recovery) then sees a
 * socket that is neither host nor active player, drops the push silently, and
 * the rejoin's own broadcast overwrites the turn the player already committed
 * locally. Parking it here instead puts it behind the joinRoom ack.
 *
 * One slot, latest wins: every push is a full snapshot of the synced keys, so
 * an older parked one describes a state the newer one already supersedes.
 */
let parkedPush: PushStatePayload | null = null;

// The single retry armed for a push refused as 'unauthorized' right after a
// reconnect (see emitPushState). Held so every teardown path can cancel it.
let pushRejoinRetryTimer: ReturnType<typeof setTimeout> | null = null;

// When this client last reconnected, or null if it has not. An 'unauthorized'
// refusal within PUSH_REJOIN_RACE_WINDOW_MS of that is read as the rejoin race
// rather than as a real refusal.
let lastReconnectAt: number | null = null;

/**
 * Forgets any push this client is still holding for the current room.
 *
 * Module state, so `set(clearRoomState())` cannot reach it — every path that
 * abandons the room (leaveRoom, the kicked/seatTakenOver surrender,
 * cancelReconnect, useGameStore's reset) calls this alongside it. Without it a
 * move made in a room the player has already left would be flushed into
 * whatever room the next reconnect finds them in.
 */
export const clearPendingPush = (): void => {
  parkedPush = null;
  if (pushRejoinRetryTimer !== null) {
    clearTimeout(pushRejoinRetryTimer);
    pushRejoinRetryTimer = null;
  }
  lastReconnectAt = null;
};

// Test-only escape hatch, the socket twin of timers.ts's _resetTimersForTests:
// the pending cleanup above is module state, so a cancelReconnect left
// in flight by one test would be torn down by the NEXT test's call and
// count against its disconnect assertions. reset() cannot reach it. The
// parked push and its retry timer are module state for the same reason.
export const _resetSocketSliceForTests = (): void => {
  pendingCancelReconnectCleanup?.();
  pendingCancelReconnectCleanup = null;
  clearPendingPush();
};

type SocketSliceSet = Parameters<ImmerStateCreator<SocketSlice>>[0];
type SocketSliceGet = Parameters<ImmerStateCreator<SocketSlice>>[1];

// Global stats are submitted by the host over the socket, so no secret token
// needs to be compiled into the client bundle: the server validates the sender
// is the room host by socket identity.
//
// Safe to call more than once for the same game. The server refuses it unless
// room.state.finished, and records it once per game (statsRecordedForGame.global,
// reset when the next one starts) — which is what lets the host-promotion path
// below fire it without having to know whether the departed host already did.
const submitGlobalStats = (get: SocketSliceGet): void => {
  const socket = getSocket();
  if (!socket) return;
  socket.emit('submitGlobalStats', {
    roomId: get().roomId,
    payload: get().buildGlobalStatsPayload(),
  });
};

/**
 * Sends one push and acts on what the server says about it.
 *
 * The ack is optional on the wire in both directions: a server predating it
 * simply never invokes the callback, which is indistinguishable from a push
 * nobody objected to — so silence is success. A refusal is not silent:
 *
 *  - 'unauthorized' shortly after a reconnect is almost always this client's
 *    own rejoin not having landed yet, so the same snapshot is re-sent ONCE
 *    (`retryable` is false on that retry, and on every push that follows).
 *  - anything else — and a second 'unauthorized' — is a push the room has
 *    genuinely thrown away. The player is told, and a fresh snapshot is pulled
 *    so the client stops rendering a turn the room never accepted.
 */
const emitPushState = (
  sock: Socket,
  payload: PushStatePayload,
  get: SocketSliceGet,
  retryable: boolean,
): void => {
  sock.emit('pushState', payload, (ack?: PushStateAck) => {
    if (!ack || ack.ok) return;

    const racedOwnRejoin = ack.reason === 'unauthorized' && retryable &&
      lastReconnectAt !== null && Date.now() - lastReconnectAt <= PUSH_REJOIN_RACE_WINDOW_MS;
    if (racedOwnRejoin) {
      if (pushRejoinRetryTimer !== null) clearTimeout(pushRejoinRetryTimer);
      pushRejoinRetryTimer = setTimeout(() => {
        pushRejoinRetryTimer = null;
        const current = getSocket();
        if (current) emitPushState(current, payload, get, false);
      }, PUSH_REJOIN_RETRY_DELAY_MS);
      return;
    }

    get().addToast(i18n.t('game.toastPushRefused',
      'Your last move was not accepted by the server; the game state was refreshed.'));
    // Answered with a gameState to this socket alone. The room broadcasts on
    // its own schedule, and a refused push may be the last thing that would
    // have happened in it for a while — this client cannot afford to wait.
    getSocket()?.emit('requestState', { roomId: payload.roomId });
  });
};

/**
 * Sends the push held for a transport drop, now that the rejoin has been acked.
 *
 * Cleared before the emit, not after: the flush must be one-shot even if the
 * emit itself throws.
 */
const flushParkedPush = (get: SocketSliceGet): void => {
  const payload = parkedPush;
  parkedPush = null;
  if (!payload) return;
  const sock = getSocket();
  if (sock) emitPushState(sock, payload, get, true);
};

// Wires every server->client event for one socket connection. Extracted out of
// connectSocket (which just creates the socket and delegates here) so the
// event-bus itself is a standalone, independently readable unit rather than a
// 150-line inline factory.
const registerSocketHandlers = (sock: Socket, get: SocketSliceGet, set: SocketSliceSet): void => {
  // `stateVersion` rides alongside the synced fields (server/rooms.ts's
  // emitRoomState bumps it once per broadcast) but is not one of them: it is
  // server-derived metadata, deliberately absent from SYNCED_GAME_STATE_KEYS
  // so the sync loop below cannot apply it and a push can never write it.
  sock.on('gameState', (serverState: Partial<GameStore> & { stateVersion?: number }) => {
    // A broadcast can land after this client already returned to local mode
    // (leaveRoom/kicked flip the mode before the socket fully tears down).
    // Applying it would inject the online room into local state — which the
    // local persistence subscriber would immediately write to disk. Every
    // teardown path upholds this invariant on its own; the guard makes it
    // structural instead of distributed.
    //
    // roomId as well as mode, because the mode check alone cannot see a leave
    // that stays online: clearRoomState contains neither `mode` nor
    // `isOnline`, and four of leaveRoom's five call sites deliberately keep
    // the user in online mode on the join form. The server only drops the
    // socket from the channel when it processes the leave, so a broadcast
    // emitted during that round trip still arrives — and restoring
    // players/finished/currentPlayerIndex is enough for App.tsx to route back
    // into Game/EndScreen over a store with no room, where every action
    // silently no-ops and syncOnlineTimers restarts the countdown that was
    // just stopped. roomId is set in the same tick as mode on the way in (the
    // joinRoom ack), so this closes a window rather than opening one.
    if (get().mode !== 'online' || !get().roomId) return;

    // A straggler from before something this client has already applied — a
    // broadcast that overtook a newer one, or the room's own pre-push state
    // arriving after the push that superseded it. Applying it would undo a
    // turn already committed here, and the next broadcast would not
    // necessarily correct it. Only a STRICTLY lower version is dropped:
    // equal still applies (the requestState reply re-sends the same version),
    // and a missing one applies too, so an older server keeps working.
    const incomingVersion = serverState.stateVersion;
    const floor = get().lastAppliedStateVersion;
    if (typeof incomingVersion === 'number' && floor !== null && incomingVersion < floor) return;

    const wasFinished = get().finished;
    set((prev) => {
      const wasDisconnected = prev.showReconnectPopup;

      // The first sync after joining describes the room as it already is —
      // only LATER diffs are host changes worth announcing.
      const firstRoomSync = !prev.roomStateSynced;
      prev.roomStateSynced = true;

      if (!firstRoomSync && prev.mode === 'online' && prev.status === 'lobby' && serverState.status === 'lobby') {
        // Each diff is guarded with `key in serverState`, matching the sync
        // loop below: serverState is typed Partial<GameStore>, so an absent
        // key must read as "unchanged", not "changed to undefined" (which
        // would toast e.g. "Winning score: undefined").
        if ('winningScore' in serverState && prev.winningScore !== serverState.winningScore) {
          prev.toasts.push(makeToast(i18n.t('game.toastWinningScore', {
            defaultValue: 'Winning score: {{value}}',
            value: serverState.winningScore,
          })));
        }
        if ('turnDuration' in serverState && prev.turnDuration !== serverState.turnDuration) {
          const value = serverState.turnDuration === 0
            ? i18n.t('common.disabled', 'Disabled')
            : i18n.t('game.timeSeconds', { defaultValue: '{{time}}s', time: serverState.turnDuration });
          prev.toasts.push(makeToast(i18n.t('game.toastTurnTimer', { defaultValue: 'Turn timer: {{value}}', value })));
        }
        if ('reconnectTimeout' in serverState && prev.reconnectTimeout !== serverState.reconnectTimeout) {
          prev.toasts.push(makeToast(i18n.t('game.toastKickTimer', {
            defaultValue: 'Kick timer: {{value}}',
            value: `${serverState.reconnectTimeout}s`,
          })));
        }
        if (serverState.initialCards && !areInitialCardsEqual(prev.initialCards, serverState.initialCards)) {
          prev.toasts.push(makeToast(i18n.t('game.toastDeckChanged', 'Deck composition changed')));
        }
        if ('enforcedDiceMode' in serverState && prev.enforcedDiceMode !== serverState.enforcedDiceMode) {
          const value = serverState.enforcedDiceMode === null
            ? i18n.t('common.disabled', 'Disabled')
            : serverState.enforcedDiceMode === 'digital'
              ? i18n.t('lobby.digitalDice', 'Digital Dice')
              : i18n.t('lobby.physicalDice', 'Physical Dice');
          prev.toasts.push(makeToast(i18n.t('game.toastDiceModeEnforced', { defaultValue: 'Dice mode: {{value}}', value })));
        }
        if ('ruleset' in serverState && prev.ruleset !== serverState.ruleset) {
          const value = serverState.ruleset === 'classic'
            ? i18n.t('lobby.rulesetClassic', 'Classic')
            : i18n.t('lobby.rulesetModernized', 'Modernized');
          prev.toasts.push(makeToast(i18n.t('game.toastRuleset', { defaultValue: 'Rules: {{value}}', value })));
        }
      }
      if (prev.mode === 'online' && prev.status === 'playing' && serverState.status === 'lobby' && !prev.finished && (serverState.players?.length ?? 0) >= 2) {
        prev.toasts.push(makeToast(i18n.t('game.toastHostEndedEarly', 'Host ended game early')));
      }
      for (const key of GAME_STATE_SYNC_KEYS) {
        if (key in serverState) (prev as Record<string, unknown>)[key] = serverState[key];
      }
      if (typeof incomingVersion === 'number') prev.lastAppliedStateVersion = incomingVersion;

      const isNewReconnect = wasDisconnected && serverState.status === 'playing';
      if (isNewReconnect) {
        prev.justReconnected = true;
      } else if (prev.justReconnected) {
        // Self-clearing: true for exactly one gameState event's processing
        // window, then reset here on the next one — regardless of whether
        // any component (e.g. Game.tsx) was mounted to react to it and
        // clear it itself. Without this it could get stuck true forever
        // (e.g. reconnecting as a spectator, or on physical dice) and
        // wrongly resurface on a later, unrelated turn.
        prev.justReconnected = false;
      }
      prev.showReconnectPopup = false;
    });
    // Pass the server-computed remaining turn time so the display countdown
    // resyncs to it (see syncOnlineTimers for why it is authoritative).
    get().syncOnlineTimers(serverState.turnTimeRemaining);

    if (!wasFinished && get().finished) {
      // Frozen BEFORE the submission, and kept for the promotion path that may
      // submit much later: a host promotion on a dead host only fires when the
      // disconnect timer drains, and the server splices that seat before it
      // broadcasts — so by then the roster is missing the player who left, very
      // often the winner.
      //
      // This edge covers every client that WATCHES the finish. The one that
      // caused it sets `finished` locally first, so the echo is no edge at all
      // — gameSlice.nextTurn freezes it there, through the same helper.
      set({ finishedGameSnapshot: finishedGameSnapshotOf(get()) });
      get().sendOnlineStats();
    }
  });

  sock.on('playerDisconnected', (name: string) => {
    const seconds = get().reconnectTimeout;
    // 0 = the kick timer is disabled for this room (see configValidation.ts)
    // — there is no deadline, so a message inventing one is misleading.
    if (!seconds) {
      get().addToast(i18n.t('game.playerDisconnectedNoTimeout', {
        defaultValue: '{{name}} disconnected!',
        name,
      }));
      return;
    }
    get().addToast(i18n.t('game.playerDisconnected', {
      defaultValue: '{{name}} disconnected! They have {{seconds}} seconds to reconnect.',
      name,
      seconds,
    }));
  });

  sock.on('nameConflictWithDisconnected', (name: string) => {
    get().addToast(i18n.t('game.nameConflictWithDisconnected', {
      defaultValue: 'Someone tried to join as "{{name}}", which belongs to a disconnected player. Kick them below to free up the name.',
      name,
    }));
  });

  sock.on('playerReaction', (reaction: Reaction) => {
    set((state) => { state.reactions.push(reaction); });
    // Self-pruning, like toasts — the sender only needs the id/timing
    // contract, not a per-reaction cleanup call from the UI layer.
    setTimeout(() => get().removeReaction(reaction.id), REACTION_DISPLAY_MS);
  });

  sock.on('hostId', (hostSocketId: string) => {
    const wasHost = get().isHost;
    const isNowHost = hostSocketId === sock.id;
    set({ isHost: isNowHost, hostId: hostSocketId });

    // Only the host submits global stats, and only on the tick where
    // `finished` flips (see the gameState handler). A host whose socket died
    // before the winning push landed never saw that tick, and every client
    // that did was not host — so the game went unrecorded. Being promoted onto
    // an already-finished game is the one moment left to catch it. Narrow on
    // purpose: emitRoomState broadcasts hostId with every gameState, so this
    // arrives repeatedly through the whole end screen, and only the
    // not-host -> host transition may act on it.
    if (!wasHost && isNowHost && get().finished) submitGlobalStats(get);
  });

  // Dedicated low-frequency-cost path for live dice-roll updates (see
  // pushLiveTurnState) — a plain single-field merge, deliberately not
  // routed through the 'gameState' handler above so a dice tick doesn't
  // re-run its toast-diffing/justReconnected/timer-sync/stats side
  // effects, none of which apply here.
  sock.on('liveTurnState', (payload: { liveTurnState: DiceSnapshot | null }) => {
    set({ liveTurnState: payload.liveTurnState });
  });

  // Losing the seat, whichever way it happened: say why, then tear the room
  // down. Mirrors leaveRoom's reset (see its comment): setMode('local') below
  // only overwrites the keys a saved local game happens to contain, so without
  // clearing the online room's roster/game state here too, it bleeds into
  // local mode whenever there's no local save to overwrite it.
  const surrenderSeat = (message: string): void => {
    get().addToast(message);
    get().stopOnlineTimers();
    sessionStore.remove('tutto_online_session');
    clearTurnCaches();
    clearPendingPush();
    set(clearRoomState());
    get().setMode('local');
  };

  sock.on('kicked', () => {
    surrenderSeat(i18n.t('game.kickedByHost', 'You were kicked by the host'));
  });

  // The same device joined again from somewhere else (a second tab, the app
  // reopened) and the server moved the seat to that connection. Without this
  // the superseded tab kept a full-looking room whose every action silently
  // did nothing.
  sock.on('seatTakenOver', () => {
    surrenderSeat(i18n.t('game.seatTakenOver',
      'This device joined the room from somewhere else, so this window left it.'));
  });

  sock.on('gameAborted', () => {
    get().addToast(i18n.t('game.aborted'));
  });

  sock.on('disconnect', () => {
    // Only a client holding a seat has anything to reconnect TO. Online mode
    // alone is not enough: sitting on the join form (after leaving a room or
    // finishing a game) there is no room to recover, and the 'connect' handler
    // below would have had no rejoin to run — so the full-screen "attempting
    // to reconnect" modal stayed up over a connection that was already back.
    const { mode, roomId, myName } = get();
    if (mode === 'online' && roomId && myName) set({ showReconnectPopup: true });
  });

  sock.on('connect', () => {
    // Stamped before the early return: an 'unauthorized' push refusal is only
    // excused as a rejoin race for a short window after this moment.
    lastReconnectAt = Date.now();
    const { mode, roomId, myName, deviceId } = get();
    if (!roomId || !myName) {
      // Nothing to rejoin, so anything the drop raised is now stale. Limited
      // to online mode because a session restore raises the popup itself and
      // only then calls joinRoom: until the server acks that join the store
      // still holds no room AND is still in local mode, and this very
      // connection is the one carrying it — lowering it here would pull the
      // modal out from under an attempt that is still running.
      if (mode === 'online') set({ showReconnectPopup: false });
      return;
    }
    const savedColor = localStore.read('tutto_color');

    // The same deadline the lobby's join button and the reconnect popup's
    // "Yes, Reconnect" already race their joins against — this path had none,
    // and it is the one nobody is watching a button for. An ack can go missing
    // on a socket that stays perfectly healthy: safeOn (server/socketContext)
    // catches a throwing handler and logs it, so no ack is ever sent and no
    // later 'connect' fires to retry. Without this the full-screen "attempting
    // to reconnect" modal stayed up for good, with the menu button as the only
    // way out.
    const watchdog = setTimeout(() => {
      get().addToast(i18n.t('lobby.online.joinTimeout', 'No response from the server. Please try again.'));
      set({ showReconnectPopup: false });
    }, JOIN_TIMEOUT_MS);

    sock.emit('joinRoom', { roomId, name: myName, deviceId, color: savedColor, isReconnect: true }, (res: JoinRoomResponse) => {
      clearTimeout(watchdog);
      if (res.success) {
        // The floor goes with the connection: the room may have been
        // recreated under the same id while this client was away, and its
        // versions then start over below whatever floor was carried in.
        set({ isHost: res.isHost ?? false, myName: res.name ?? myName, lastAppliedStateVersion: null });
        // Only now: the seat is this socket's again, so the push made during
        // the drop can finally pass the server's authorization gate.
        flushParkedPush(get);
        return;
      }
      // The seat is unrecoverable (room deleted after the reconnect
      // timeout, name reclaimed, …) — retrying on the next 'connect'
      // can never succeed, so stop showing the "attempting to
      // reconnect" popup and drop back to the online join form. The parked
      // push goes with it: there is no seat left for it to land in.
      clearPendingPush();
      get().addToast(
        joinErrorMessage(res, (key, defaultValue) => i18n.t(key, defaultValue))
          ?? i18n.t('home.restore.failed', 'Failed to reconnect to the game'),
      );
      get().leaveRoom();
      set({ showReconnectPopup: false, hostId: null });
      // room-gone specifically (see server/socketRoomHandlers.ts, item A10):
      // the room itself is gone, not just this seat, so there is nothing left
      // to show an "online join form" for — land back on local Home instead
      // (leaveRoom above already dropped tutto_online_session), and drop any
      // stale restore prompt this device might also be holding.
      if (res.code === 'room-gone') {
        set({ pendingReconnectSession: null });
        get().setMode('local');
      }
    });
  });
};

export const createSocketSlice: ImmerStateCreator<SocketSlice> = (set, get) => ({
  cancelReconnect: (roomId?: string | null, name?: string | null) => {
    pendingCancelReconnectCleanup?.();
    pendingCancelReconnectCleanup = null;

    clearTurnCaches();
    clearPendingPush();
    sessionStore.remove('tutto_online_session');
    set({ pendingReconnectSession: null, liveTurnState: null, showReconnectPopup: false });

    // Abandoning an active room (the "Return to Main Menu" path) must also drop
    // the room identity and game state from the store — the setMode('local')
    // that follows only overwrites the keys a saved local game happens to
    // contain, so without this the stale roomId later renders a phantom
    // joined-room lobby (or the online roster bleeds into local mode).
    // Guarded on the STORE's roomId: declining the restore prompt on a fresh
    // page load (store roomId never set — the roomId argument here identifies
    // the room to leave server-side) must not wipe a restored local game.
    if (get().roomId) {
      set(clearRoomState());
    }

    if (!roomId) return;

    const tempSocket = io(window.location.origin);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeoutId);
      tempSocket.disconnect();
      if (pendingCancelReconnectCleanup === cleanup) pendingCancelReconnectCleanup = null;
    };
    pendingCancelReconnectCleanup = cleanup;
    const timeoutId = setTimeout(cleanup, 10000);

    tempSocket.on('connect_error', cleanup);
    tempSocket.on('connect', () => {
      const savedColor = localStore.read('tutto_color');
      tempSocket.emit('joinRoom', {
        roomId,
        name,
        deviceId: get().deviceId,
        color: savedColor,
        // A reconnect, so a room the server no longer has is refused
        // (room-gone) instead of being created and immediately deleted.
        isReconnect: true,
      }, (res: JoinRoomResponse) => {
        if (res?.success) tempSocket.emit('leaveRoom');
        cleanup();
      });
    });
  },

  connectSocket: (url?: string) => {
    if (!getSocket()) {
      const sock = io(url ?? window.location.origin);
      setSocket(sock);
      registerSocketHandlers(sock, get, set);
    }
  },

  joinRoom: (room, name, isReconnect = false) => {
    if (!isReconnect) {
      clearTurnCaches();
      set({ liveTurnState: null });
    }
    // The first gameState after ANY join is the room introducing itself, not
    // the host changing something — the config-diff toasts must not fire for
    // it (they would announce every difference between this device's saved
    // host config and the room's actual settings as "changes").
    set({ roomStateSynced: false });
    return new Promise<JoinRoomResponse>((resolve) => {
      let initialConfig: Partial<Pick<GameStore, ConfigKeys>> | undefined = undefined;
      try {
        const storedConfigStr = localStore.read('tutto_online_config');
        if (storedConfigStr) {
          // Only transmit fields the server would accept — same validator the
          // lobby uses when loading this config, so both stay in sync.
          const validated = validateOnlineConfig(JSON.parse(storedConfigStr));
          if (Object.keys(validated).length > 0) initialConfig = validated;
        }
      } catch (e) {
        console.error('Failed to parse online config for joinRoom', e);
      }

      get().connectSocket();
      const savedColor = localStore.read('tutto_color');
      const socket = getSocket();
      if (!socket) {
        resolve({ success: false, error: 'Socket not connected' });
        return;
      }
      socket.emit('joinRoom', { roomId: room, name, deviceId: get().deviceId, color: savedColor, initialConfig, isReconnect }, (res: JoinRoomResponse) => {
        if (res.success) {
          // Adopt the name the server seated us under — a mid-game rejoin with
          // a different name keeps the seat's original name (see JoinRoomResponse).
          const seatedName = res.name ?? name;
          set({ roomId: room, isHost: res.isHost ?? false, myName: seatedName, mode: 'online', isOnline: true });
          sessionStore.write('tutto_online_session', JSON.stringify({ roomId: room, myName: seatedName }));

          if (res.isHost && !isReconnect && initialConfig) {
            get().addToast(i18n.t('lobby.savedSettingsLoaded'));
          }
        }
        resolve(res);
      });
    });
  },

  leaveRoom: () => {
    const socket = getSocket();
    if (socket) socket.emit('leaveRoom');
    get().stopOnlineTimers();
    sessionStore.remove('tutto_online_session');
    clearTurnCaches();
    clearPendingPush();
    set(clearRoomState());
  },

  kickPlayer: (targetSocketId) => {
    const socket = getSocket();
    if (get().isHost && socket) socket.emit('kickPlayer', targetSocketId);
  },

  // Dedicated low-overhead sibling to pushState, used only for the
  // ~300ms-cadence live dice-roll snapshot (see gameSlice.setLiveTurnState).
  // Sends just this one field instead of the full state bundle pushState
  // gathers below — pushState itself is untouched and still carries
  // liveTurnState as part of the full sync for every other mutation.
  pushLiveTurnState: (snapshot) => {
    const s = get();
    const socket = getSocket();
    if (s.isOnline && socket) {
      socket.emit('liveTurnState', { roomId: s.roomId, liveTurnState: snapshot });
    }
  },

  pushState: () => {
    const s = get();
    const socket = getSocket();
    if (s.isOnline && socket) {
      const {
        players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
        randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
        previousScore, previousCard, previousLeaders, previousWasBust, previousWasSuccess,
        previousHighestTurnScore,
        previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
        previousPlayerName, previousTurnSummary, chartValues, chartNames, chartLabels, status,
        liveTurnState, enforcedDiceMode, ruleset, historyLog,
      } = s;
      const payload: PushStatePayload = {
        roomId: s.roomId,
        newState: {
          players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
          randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
          previousScore, previousCard, previousLeaders, previousWasBust, previousWasSuccess,
          previousHighestTurnScore,
          previousHighestFeuerwerkTurnScore, previousHighestX2TurnScore,
          previousPlayerName, previousTurnSummary, chartValues, chartNames, chartLabels, status,
          liveTurnState, enforcedDiceMode, ruleset, historyLog,
          // The wire payload is the sixth hand-written copy of the synced
          // field set (destructure above + literal here). satisfies makes it
          // the compiler's problem: a canonical key missing here refuses to
          // build, and the shorthand identifiers force the destructure to
          // carry whatever the literal names — without this, a new synced
          // field passed every other lock and still never reached the wire,
          // where applyPushedState's allowlist loop silently dropped it.
          //
          // stateVersion is NOT here on purpose: it is the server's own
          // counter, not a field a client may write.
        } satisfies Record<SyncedGameStateKey, unknown>,
      };

      // Park rather than let socket.io buffer it — see parkedPush for why
      // the library's own buffering is the bug and not the fix.
      if (!socket.connected) {
        parkedPush = payload;
        return;
      }
      emitPushState(socket, payload, get, true);
    }
  },

  sendOnlineStats: () => {
    const s = get();
    const socket = getSocket();
    // The payload itself lives in coreGameEngine beside its global
    // counterpart, so the integration suite can build the very same one
    // instead of keeping a copy that drifts.
    const stats = buildDeviceStatsPayload(s.players, s.myName, s.gameTimeInSeconds, s.round);
    if (stats && socket) {
      socket.emit('endGameStats', { roomId: s.roomId, deviceId: s.deviceId, stats });
    }

    if (s.isHost) submitGlobalStats(get);
  },
});
