import { rooms, emitRoomState } from './rooms';
import { applyValidatedConfig } from './roomConfigValidation';
import { startServerTurnTimer } from './turnTimers';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';
import { normalizeRoomId } from '../src/utils/configValidation';
import type { AssertNever, ConfigKeys, DiceMode } from '../src/types';

const UPDATE_CONFIG_LIMIT = { windowMs: 1_000, max: 20 };

const LOBBY_CONFIG_FIELDS = [
  'winningScore', 'initialCards', 'randomOrder', 'reconnectTimeout', 'enforcedDiceMode', 'ruleset',
] as const satisfies readonly ConfigKeys[];
const MID_GAME_CONFIG_FIELDS = ['turnDuration'] as const satisfies readonly ConfigKeys[];

export type ConfigPolicyLock = [
  AssertNever<Exclude<ConfigKeys, (typeof LOBBY_CONFIG_FIELDS)[number] | (typeof MID_GAME_CONFIG_FIELDS)[number]>>,
  AssertNever<Extract<(typeof LOBBY_CONFIG_FIELDS)[number], (typeof MID_GAME_CONFIG_FIELDS)[number]>>,
];

type UpdateConfigPayload = Partial<Record<ConfigKeys, unknown>>;

const pickConfig = <T extends readonly ConfigKeys[]>(data: UpdateConfigPayload, fields: T): Record<T[number], unknown> =>
  Object.fromEntries(fields.map(field => [field, data[field]])) as Record<T[number], unknown>;

/** Host-only changes to how the room's game is set up. */
export const registerConfigHandlers = ({ io, socket }: SocketContext): void => {
  const updateConfigLimiter = createSocketEventLimiter(UPDATE_CONFIG_LIMIT);

  safeOn(socket, 'updateConfig', (data: {
    roomId?: string;
    winningScore?: number;
    initialCards?: unknown;
    randomOrder?: boolean;
    turnDuration?: number;
    reconnectTimeout?: number;
    enforcedDiceMode?: DiceMode | null;
    ruleset?: unknown;
  } | null | undefined) => {
    if (!updateConfigLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId } = data;
    // Same normalization joinRoom applies before ever touching `rooms` — a
    // client always holds the canonical id post-join, but this keeps the
    // lookup correct regardless of what case a caller happens to send.
    if (typeof rawRoomId !== 'string') return;
    const roomId = normalizeRoomId(rawRoomId);
    if (!rooms[roomId] || rooms[roomId].host !== socket.id) return;
    const state = rooms[roomId].state;
    if (state.status === 'lobby') {
      applyValidatedConfig(state, {
        ...pickConfig(data, LOBBY_CONFIG_FIELDS),
        ...pickConfig(data, MID_GAME_CONFIG_FIELDS),
      });
    } else {
      // Every field except turnDuration is a lobby-only concept — a stray
      // or malicious mid-game event must not be able to flip the win
      // condition (winningScore) or rebuild the deck (initialCards) out
      // from under an active game, same rule reorderPlayers enforces in the
      // roster handlers. turnDuration is the deliberate exception: the host
      // can shorten it to 0 mid-turn to cancel a pending expiry — no current
      // UI exposes this, but the server supports it intentionally (see
      // turnTimer.test.ts's "turnDuration=0 mid-turn cancels a pending
      // expiry").
      applyValidatedConfig(state, pickConfig(data, MID_GAME_CONFIG_FIELDS));
    }
    // Resync the pending expiry to the (possibly just-changed) turnDuration. A
    // no-op if no turn is in progress; startServerTurnTimer's own guards handle that.
    startServerTurnTimer(io, roomId);
    emitRoomState(io, roomId);
  });
};
