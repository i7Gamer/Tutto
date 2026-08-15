import { rooms, roomChannel } from './rooms';
import { REACTION_EMOJIS } from '../src/utils/reactions';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';

// One reaction per second per connection — a deliberate UX pace, not just
// abuse protection, so it uses the same limiter mechanism as every other
// event instead of the ad-hoc timestamp cooldown it replaced.
const SEND_REACTION_LIMIT = { windowMs: 1_000, max: 1 };

/** Emoji a player throws at the table. */
export const registerReactionHandlers = ({ io, socket, session }: SocketContext): void => {
  const sendReactionLimiter = createSocketEventLimiter(SEND_REACTION_LIMIT);

  safeOn(socket, 'sendReaction', (data: { emoji?: string } | null | undefined) => {
    if (!sendReactionLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { emoji } = data;
    // Uses the session's own tracked room rather than a client-supplied
    // roomId — a reaction only ever needs to broadcast to the room this
    // socket is actually seated in.
    const roomId = session.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (typeof emoji !== 'string' || !(REACTION_EMOJIS as readonly string[]).includes(emoji)) return;

    const room = rooms[roomId];
    const sender = room.state.players.find(p => p.socketId === socket.id);
    if (!sender) return;
    io.to(roomChannel(roomId)).emit('playerReaction', {
      id: Date.now() + Math.random(),
      emoji,
      senderName: sender.name,
      senderColor: sender.color,
    });
  });
};
