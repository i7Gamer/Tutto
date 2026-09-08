import { describe, expect, it } from 'vitest';
import { makePlayer } from '../testing/factories';
import { PLAYER_RECORD_FIELDS } from '../utils/playerStats';
import { serializePlayersForPush } from './playerPushDto';

const RECORDED_VALUE = 1200;

describe('serializePlayersForPush', () => {
  it('encodes absent records as explicit JSON nulls', () => {
    const player = makePlayer({ name: 'Alice' });

    const serialized = serializePlayersForPush([player]);
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>[];

    for (const field of PLAYER_RECORD_FIELDS) {
      expect(roundTripped[0][field], field).toBeNull();
    }
  });

  it('preserves numeric records, unrelated fields, and the input roster', () => {
    const player = makePlayer({ name: 'Alice', score: 500, highestTurnScore: RECORDED_VALUE });

    const serialized = serializePlayersForPush([player]);

    expect(serialized[0].highestTurnScore).toBe(RECORDED_VALUE);
    expect(serialized[0].score).toBe(500);
    expect(player.highestTurnScore).toBe(RECORDED_VALUE);
    expect(player).not.toHaveProperty('highestFeuerwerkTurnScore');
  });
});
