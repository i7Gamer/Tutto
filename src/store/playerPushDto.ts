import type { Player } from '../types';
import { PLAYER_RECORD_FIELDS, type PlayerRecordField } from '../utils/playerStats';

/**
 * The player roster shape sent in a pushState payload.
 *
 * The engine uses `undefined` for a record that has not been set yet, but JSON
 * omits undefined object properties. Explicit null keeps that distinction on
 * the wire so the server can delete an old record during an undo.
 */
export type PlayerPushDto = Omit<Player, PlayerRecordField> & {
  [K in PlayerRecordField]: number | null;
};

/**
 * Copies a roster for pushState, encoding every absent optional record as null.
 * The input players are never mutated.
 */
export const serializePlayersForPush = (players: readonly Player[]): PlayerPushDto[] =>
  players.map((player) => {
    const dto = { ...player } as PlayerPushDto;
    for (const field of PLAYER_RECORD_FIELDS) {
      if (player[field] === undefined) dto[field] = null;
    }
    return dto;
  });
