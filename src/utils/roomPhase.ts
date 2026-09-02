/**
 * The room lifecycle actually has three phases, but the wire state only ever
 * had two fields to spell them with: `status` ('lobby' | 'playing') and
 * `finished`. A finished game does NOT flip status back — it stays 'playing'
 * with finished: true all the way through the end screen, because Play
 * Again's finished->playing transition never passes through the lobby. See
 * socketGameStateHandlers.ts's `startingGame` for why that matters.
 *
 * Every read site that cares "is this room actually mid-game" ended up
 * re-deriving the same `status === 'playing' && !finished` (or its inverse)
 * by hand, each with its own comment re-explaining the trap. This is the one
 * place that answer lives — server and client both read it, so it lives here
 * rather than in server/rooms.ts, which the client cannot import from.
 *
 * `finished` wins over `status` by construction: a room can only reach
 * finished: true from status 'playing' (see pushValidation's `applyFinished`
 * and turnTimers' `advanceTurnOnTimeout`), and nothing ever sets status back
 * to 'lobby' without first clearing finished (abortGameIfLowPlayers clears
 * both together; Play Again's startingGame clears finished via the incoming
 * push). So status: 'lobby' with finished: true never arises from normal
 * play — but if it ever did (a malformed push, a hand-built test fixture),
 * treating it as 'finished' is the safe read: it can never be mistaken for a
 * live game still being able to accept a turn.
 */
export type RoomPhase = 'lobby' | 'playing' | 'finished';

/** The two RoomState fields roomPhase reads. Duck-typed so both the server's
 * RoomState and the client store's flattened fields satisfy it without either
 * importing the other's type. */
export interface RoomPhaseFields {
  status: 'lobby' | 'playing';
  finished: boolean;
}

export const roomPhase = ({ status, finished }: RoomPhaseFields): RoomPhase => {
  if (finished) return 'finished';
  if (status === 'lobby') return 'lobby';
  return 'playing';
};
