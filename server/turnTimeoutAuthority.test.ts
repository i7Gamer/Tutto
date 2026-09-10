/** @vitest-environment node */
import { afterEach, expect, it } from 'vitest';
import { createRoom, deleteRoom, rooms } from './rooms';
import { advanceTurnOnTimeout } from './turnTimers';
import { makeFakeIo, makeServerPlayer } from './socketTestHarness';

const roomId = 'TIMEOUT-AUTHORITY';
afterEach(() => deleteRoom(roomId));

it('does not turn a fabricated live chain into authoritative counters', () => {
  const room = rooms[roomId] = createRoom('host');
  Object.assign(room.state, { status: 'playing', ruleset: 'classic', currentPlayerIndex: 0, currentCard: '300',
    players: [makeServerPlayer('Alice'), makeServerPlayer('Bob')],
    liveTurnState: { cardsThisTurn: ['Plus_Minus', 'Kleeblatt'], chainTuttoCount: 50, plusMinusScores: [0],
      turnScore: 999999, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 },
  });
  room.dealtThisTurn = ['300'];
  advanceTurnOnTimeout(makeFakeIo().io, roomId);
  expect(room.state.players[0].totalTuttos).toBe(0);
  expect(room.state.players[0].timesPlusMinusCompleted).toBe(0);
  expect(room.state.players[0].highestForfeitedTurnScore ?? 0).toBe(0);
  expect(room.state.previousTurnSummary?.cards.map(card => card.card)).toEqual(['300']);
});
