/**
 * @vitest-environment node
 *
 * In-process unit tests for the pushState validation/merge layer. The E2E
 * socket suites (sockets.test.ts, pushStateValidation.test.ts) prove the same
 * rules hold over the wire; these tests pin every individual field branch
 * cheaply and show up in coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  applyPushedState,
  applyValidatedConfig,
  validateInitialCards,
  validatePushedPlayers,
  isPlausiblePlayerSnapshot,
  isValidDiceSnapshot,
  sanitizeDiceSnapshot,
  isValidTurnSummary,
  sanitizeTurnSummary,
  MAX_SCORE_MAGNITUDE,
} from './pushValidation';
import { createRoom } from './rooms';
import { MIN_ENABLED_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import { PLAYER_STAT_FIELDS } from '../src/utils/playerStats';
import type { RoomState, ServerPlayer } from './roomTypes';
import { makeServerPlayer as makePlayer } from './socketTestHarness';
import type { DiceSnapshot } from '../src/types';

const makeState = (playerNames: string[] = ['Alice', 'Bob']): RoomState => {
  const state = createRoom('sock-Alice').state;
  state.players = playerNames.map(n => makePlayer(n));
  return state;
};

// pusherName is the seat the sender occupies. The host path ignores it (a host
// already writes every field), so the two host fixtures pass null; the active
// player is Alice throughout, which is what makes Bob a FOREIGN seat below.
const asHost = { isHost: true, startingGame: false, pusherName: null };
const asActivePlayer = { isHost: false, startingGame: false, pusherName: 'Alice' };
const asHostStarting = { isHost: true, startingGame: true, pusherName: null };

describe('applyPushedState', () => {
  it('accepts every stat a player accumulates', () => {
    // Derived from the one list that creates these fields, so a counter added
    // there and not admitted here fails this test rather than the players. A
    // broadcast replaces the roster wholesale: a stat this set does not accept
    // back is reset after every turn, for the whole room, silently — which is
    // what happened to the per-turn maxima before they were let in.
    const state = makeState();
    const accumulated = Object.fromEntries(PLAYER_STAT_FIELDS.map((field, i) => [field, i + 1]));

    applyPushedState(state, { players: [{ name: 'Alice', ...accumulated }, { name: 'Bob' }] }, asActivePlayer);

    for (const [field, value] of Object.entries(accumulated)) {
      expect(state.players[0][field as keyof ServerPlayer], field).toBe(value);
    }
  });

  describe('permission sets', () => {
    it('lets the host write host-only fields', () => {
      const state = makeState();
      // Carries whose turn it is, because a push may no longer leave a running
      // game with nobody to act (applyPushedState's coherence guard; the
      // behaviour is pinned in socketGameStateHandlers.test.ts). Same
      // adjustment the active-player test below needed when `finished` gained
      // its game-over rule:
      // this test is about which fields the permission set admits, not about
      // that invariant, so it satisfies it rather than working around it.
      applyPushedState(state, { status: 'playing', currentPlayerIndex: 0, winningScore: 7777, randomOrder: false }, asHost);
      expect(state.status).toBe('playing');
      expect(state.winningScore).toBe(7777);
      expect(state.randomOrder).toBe(false);
    });

    it('ignores host-only fields from the active player', () => {
      const state = makeState();
      applyPushedState(state, { status: 'playing', winningScore: 7777, turnDuration: 30, reconnectTimeout: 30, randomOrder: false, initialCards: { Stop: 1 }, enforcedDiceMode: 'digital' }, asActivePlayer);
      expect(state.status).toBe('lobby');
      expect(state.winningScore).toBe(6000);
      expect(state.turnDuration).toBe(120);
      expect(state.reconnectTimeout).toBe(60);
      expect(state.randomOrder).toBe(true);
      expect(state.initialCards.Stop).toBe(10);
      expect(state.enforcedDiceMode).toBeNull();
    });

    it('lets the active player write game-progress fields', () => {
      const state = makeState();
      // A real winner, because `finished` now needs one — see the
      // "finished needs a game that is actually over" describe below. This
      // test is about which fields the permission set admits, not about that
      // rule, so it seats the win rather than working around it.
      state.players[0].score = state.winningScore;

      applyPushedState(state, { round: 2, finished: true, currentPlayerIndex: 1 }, asActivePlayer);

      expect(state.round).toBe(2);
      expect(state.finished).toBe(true);
      expect(state.currentPlayerIndex).toBe(1);
    });
  });

  describe('players merging', () => {
    it('merges mutable numeric fields by name, keeping identity fields', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 500, deviceId: 'HIJACK', socketId: 'HIJACK' },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(500);
      expect(state.players[1].score).toBe(300);
      expect(state.players[0].deviceId).toBe('dev-Alice');
      expect(state.players[0].socketId).toBe('sock-Alice');
    });

    it('rejects a players array with the wrong length', () => {
      const state = makeState();
      applyPushedState(state, { players: [{ name: 'Alice', score: 500 }] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    // A push is one snapshot of one moment. Rejecting only its roster and
    // applying the rest let a turn advance and be logged while the score it
    // banked was silently dropped — the push described a table that no longer
    // exists, so none of it can be trusted.
    it('discards the WHOLE push when the roster it was built against is gone', () => {
      const state = makeState(['Alice', 'Bob']);
      state.round = 3;
      state.currentPlayerIndex = 0;
      state.historyLog = [];

      applyPushedState(state, {
        // Composed before Carol left, so it still carries three seats.
        players: [{ name: 'Alice', score: 5000 }, { name: 'Bob' }, { name: 'Carol' }],
        currentPlayerIndex: 1,
        round: 4,
        cards: ['300'],
        historyLog: [{ id: 'h1', round: 3, playerName: 'Alice', card: '200', type: 'success', score: 5000 }],
      }, asActivePlayer);

      expect(state.players[0].score, 'the banked score was dropped').toBe(0);
      expect(state.currentPlayerIndex, 'but the turn advanced anyway').toBe(0);
      expect(state.round, 'and the round advanced anyway').toBe(3);
      expect(state.historyLog, 'and the turn was logged anyway').toEqual([]);
    });

    it('reports whether the push was applied at all', () => {
      // The caller (socketGameStateHandlers) decides from this whether a
      // game-starting push really started a game: a snapshot discarded for a
      // stale roster must not reset the finished game's stats dedup.
      const state = makeState(['Alice', 'Bob']);
      expect(applyPushedState(state, {
        players: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
      }, asActivePlayer)).toBe(false);
      expect(applyPushedState(state, { round: 2 }, asActivePlayer)).toBe(true);
    });

    it('still applies a push that carries no roster at all', () => {
      const state = makeState();
      applyPushedState(state, { round: 2 }, asActivePlayer);
      expect(state.round).toBe(2);
    });

    it('rejects a players array containing an unknown name', () => {
      const state = makeState();
      applyPushedState(state, { players: [{ name: 'Alice', score: 500 }, { name: 'Mallory', score: 1 }] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    it('rejects non-object player entries', () => {
      const state = makeState();
      applyPushedState(state, { players: ['Alice', 'Bob'] }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
    });

    it('ignores non-finite numeric player fields and non-boolean disconnected', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: Infinity, busts: NaN, disconnected: 'yes' },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
      expect(state.players[0].busts).toBe(0);
      expect(state.players[0].disconnected).toBe(false);
      expect(state.players[1].score).toBe(300);
    });

    it('merges the per-card highest turn scores alongside the overall one', () => {
      // highestTurnScore was mergeable but its Feuerwerk/x2 siblings were not,
      // so every gameState broadcast (which replaces the client's roster
      // wholesale) reset them to undefined. That zeroed the two "Highest
      // Feuerwerk/x2 Turn" stats for online games end to end: endGameStats,
      // the global payload, EndScreen's new-record cards and the stats tiles.
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 1500, highestTurnScore: 1500, highestFeuerwerkTurnScore: 1500, highestX2TurnScore: 900 },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].highestTurnScore).toBe(1500);
      expect(state.players[0].highestFeuerwerkTurnScore).toBe(1500);
      expect(state.players[0].highestX2TurnScore).toBe(900);
    });

    it('applies the sanity cap to the per-card highest turn scores too', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', highestFeuerwerkTurnScore: 1e308, highestX2TurnScore: Infinity },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].highestFeuerwerkTurnScore).toBeUndefined();
      expect(state.players[0].highestX2TurnScore).toBeUndefined();
    });

    it('rejects a mutable numeric field magnitude beyond the sanity cap', () => {
      // A finite-but-absurd value (e.g. 1e308) would otherwise pass the
      // Number.isFinite check and ride every future broadcast to every client.
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 1e308, highestTurnScore: -1e308 },
          { name: 'Bob', score: 300 },
        ],
      }, asActivePlayer);
      expect(state.players[0].score).toBe(0);
      expect(state.players[0].highestTurnScore).toBeUndefined();
      expect(state.players[1].score).toBe(300);
    });

    it('never lets a push overwrite disconnected, even with a valid boolean', () => {
      // The server is the sole owner of this flag (set from real socket
      // connectivity in handlePlayerLeave/joinRoom). A pushState composed
      // before the sender's client saw a peer's disconnect — e.g. the active
      // player's ~300ms live-dice pushState cadence — legitimately carries a
      // stale `disconnected: false` for that peer; accepting it would flip
      // the server's flag back and hide the disconnect indefinitely.
      const state = makeState();
      state.players[1].disconnected = true;
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 10 },
          { name: 'Bob', score: 20, disconnected: false },
        ],
      }, asActivePlayer);
      expect(state.players[1].disconnected).toBe(true);
      expect(state.players[1].score).toBe(20); // other mutable fields still merge normally

      // The reverse direction is blocked too — not just "false can't clear true".
      state.players[1].disconnected = false;
      applyPushedState(state, {
        players: [
          { name: 'Alice', score: 10 },
          { name: 'Bob', score: 30, disconnected: true },
        ],
      }, asActivePlayer);
      expect(state.players[1].disconnected).toBe(false);
    });

    // Driven on the host path so it tests the colour SHAPE check and nothing
    // else: on the active-player path a foreign seat's colour is refused for
    // being foreign, which would leave the malformed-value half of this
    // assertion passing for a reason that has nothing to do with the regex.
    it('accepts a valid color and rejects a malformed one', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [
          { name: 'Alice', color: '#123abc' },
          { name: 'Bob', color: 'red' },
        ],
      }, asHost);
      expect(state.players[0].color).toBe('#123abc');
      expect(state.players[1].color).toBe('#ff0000');
    });

    // A seated player is authorized to push on their own turn, and the merge
    // then applied every mutable field to EVERY seat they named — so one
    // player could rewrite the whole table's counters and records. The poison
    // self-propagates (the next honest push re-sends the roster it synced) and
    // is finally committed by each victim's own unmodified client at game end,
    // which submits its own entry for its own device. Only score and
    // times1000PointsDeducted move across seats under the rules: the classic
    // and modernized Plus/Minus branches, and their undo, are the sole places
    // the engine writes to a player other than the one taking the turn.
    describe('a non-host push may only touch its own seat', () => {
      it('refuses another seat\'s counters, records and identity fields', () => {
        const state = makeState();
        Object.assign(state.players[1], { busts: 2, highestTurnScore: 400, position: 1 });

        applyPushedState(state, {
          players: [
            { name: 'Alice', score: 100 },
            {
              name: 'Bob',
              busts: 99,
              totalTurns: 50,
              timesKniffelCompleted: 12,
              highestTurnScore: 1_000_000,
              mostCardsInTurn: 9,
              position: 0,
              color: '#00ff00',
            },
          ],
        }, asActivePlayer);

        expect(state.players[1].busts).toBe(2);
        expect(state.players[1].totalTurns).toBe(0);
        expect(state.players[1].timesKniffelCompleted).toBe(0);
        expect(state.players[1].highestTurnScore).toBe(400);
        expect(state.players[1].mostCardsInTurn).toBeUndefined();
        expect(state.players[1].position).toBe(1);
        expect(state.players[1].color).toBe('#ff0000');
        expect(state.players[0].score, 'the pusher\'s own push still lands').toBe(100);
      });

      it('still lets a Plus/Minus deduct another seat\'s score and deduction count', () => {
        const state = makeState();
        state.players[1].score = 3000;

        applyPushedState(state, {
          players: [
            { name: 'Alice', score: 1000, timesPlusMinusCompleted: 1 },
            { name: 'Bob', score: 2000, times1000PointsDeducted: 1 },
          ],
        }, asActivePlayer);

        expect(state.players[1].score).toBe(2000);
        expect(state.players[1].times1000PointsDeducted).toBe(1);
      });

      it('leaves every mutable field writable on the pusher\'s own seat', () => {
        const state = makeState();
        const accumulated = Object.fromEntries(PLAYER_STAT_FIELDS.map((field, i) => [field, i + 1]));

        applyPushedState(state, {
          players: [
            { name: 'Alice', ...accumulated, highestTurnScore: 700, mostCardsInTurn: 4, color: '#123abc' },
            { name: 'Bob' },
          ],
        }, asActivePlayer);

        for (const [field, value] of Object.entries(accumulated)) {
          expect(state.players[0][field as keyof ServerPlayer], field).toBe(value);
        }
        expect(state.players[0].highestTurnScore).toBe(700);
        expect(state.players[0].mostCardsInTurn).toBe(4);
        expect(state.players[0].color).toBe('#123abc');
      });

      it('treats every seat as foreign when the pusher has no seat', () => {
        // Fails closed rather than open: an unnamed pusher gets the narrow
        // allow-list everywhere, never the full one.
        const state = makeState();
        applyPushedState(state, {
          players: [{ name: 'Alice', score: 100, busts: 9 }, { name: 'Bob' }],
        }, { isHost: false, startingGame: false, pusherName: null });

        expect(state.players[0].score).toBe(100);
        expect(state.players[0].busts).toBe(0);
      });

      it('does not restrict the host, who already writes every field', () => {
        const state = makeState();
        applyPushedState(state, {
          players: [{ name: 'Alice' }, { name: 'Bob', busts: 4, highestTurnScore: 800, position: 3 }],
        }, asHost);

        expect(state.players[1].busts).toBe(4);
        expect(state.players[1].highestTurnScore).toBe(800);
        expect(state.players[1].position).toBe(3);
      });
    });

    it('adopts the pushed order when starting a game with a strict permutation', () => {
      const state = makeState();
      applyPushedState(state, {
        status: 'playing',
        players: [{ name: 'Bob', score: 0 }, { name: 'Alice', score: 0 }],
      }, asHostStarting);
      expect(state.players.map(p => p.name)).toEqual(['Bob', 'Alice']);
      expect(state.players[0].deviceId).toBe('dev-Bob');
    });

    it('keeps the server order outside a game start', () => {
      const state = makeState();
      applyPushedState(state, {
        players: [{ name: 'Bob', score: 7 }, { name: 'Alice', score: 9 }],
      }, asHost);
      expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
      expect(state.players[0].score).toBe(9);
      expect(state.players[1].score).toBe(7);
    });

    it('clears the previous game\'s per-turn records on a Play Again start', () => {
      // The five optional records are absent from a fresh player
      // (createInitialPlayer builds from zeroedPlayerStats, which has none of
      // them), and mergeMutable skips any field not present in the push — so
      // a Play Again kickoff merged onto the PREVIOUS game's server player and
      // the old record survived into the new game. Because calculateNextTurn
      // only ever RAISES these maxima, the new game's genuine record then
      // never gets recorded at all.
      const state = makeState();
      Object.assign(state.players[0], {
        highestTurnScore: 3000, highestFeuerwerkTurnScore: 1200, highestX2TurnScore: 900,
        mostCardsInTurn: 5, highestForfeitedTurnScore: 2500,
      });

      applyPushedState(state, {
        players: [{ name: 'Alice', score: 0 }, { name: 'Bob', score: 0 }],
        status: 'playing',
      }, asHostStarting);

      expect(state.players[0].highestTurnScore).toBeUndefined();
      expect(state.players[0].highestFeuerwerkTurnScore).toBeUndefined();
      expect(state.players[0].highestX2TurnScore).toBeUndefined();
      expect(state.players[0].mostCardsInTurn).toBeUndefined();
      expect(state.players[0].highestForfeitedTurnScore).toBeUndefined();
    });

    it('keeps a per-turn record that an ordinary mid-game push omits', () => {
      // The counterpart: only a game START clears these. A push that simply
      // does not mention the field must not wipe the record set earlier this
      // same game.
      const state = makeState();
      Object.assign(state.players[0], { highestTurnScore: 3000, mostCardsInTurn: 5 });

      applyPushedState(state, { players: [{ name: 'Alice', score: 50 }, { name: 'Bob' }] }, asHost);

      expect(state.players[0].highestTurnScore).toBe(3000);
      expect(state.players[0].mostCardsInTurn).toBe(5);
    });

    it('rejects the whole players push when the pushed list has duplicate names (SERVER-PV-1)', () => {
      // Two pushed entries claiming the same name would both match that one
      // existing player in mergeMutable's name-keyed lookup — applying the
      // first and silently ignoring the second, while whichever other real
      // player the name doesn't belong to never gets its own update applied.
      // Safer to reject the entire players update than guess which was meant.
      const state = makeState();
      applyPushedState(state, {
        players: [{ name: 'Bob', score: 7 }, { name: 'Bob', score: 8 }],
      }, asHostStarting);
      expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
      expect(state.players[0].score).toBe(0);
      expect(state.players[1].score).toBe(0);
    });
  });

  describe('numeric config bounds (winningScore/turnDuration/reconnectTimeout)', () => {
    it.each([
      ['winningScore', 99999, true], ['winningScore', 100000, false], ['winningScore', -1, false],
      // Same MIN_WINNING_SCORE floor as updateConfig — pushState must not be a
      // side door for a winning score the config validator just rejected.
      ['winningScore', 1000, true], ['winningScore', 999, false], ['winningScore', 0, false],
      // Uses the real isValidWinningScore (integers only) rather than a local
      // bounds check — pushState must not be a side door for a fractional
      // winning score the config validator would also reject.
      ['winningScore', 6000.5, false], ['winningScore', NaN, false], ['winningScore', Infinity, false],
      // The timers deliberately keep a loose >= 0 sanity floor (tests push 1-2s turns)…
      ['turnDuration', 1, true], ['turnDuration', -1, false],
      ['turnDuration', 600, true], ['turnDuration', 601, false], ['turnDuration', NaN, false],
      // …but integers only: a pushed SUB-SECOND duration (0.05) would arm the
      // 10ms-floor server timer as a self-advancing loop that never ends the
      // game — the exact side door the winningScore rows above close.
      ['turnDuration', 0.05, false], ['turnDuration', 1.5, false],
      ['reconnectTimeout', 3600, true], ['reconnectTimeout', 3601, false], ['reconnectTimeout', Infinity, false],
      ['reconnectTimeout', 0.5, false],
    ] as [keyof RoomState, number, boolean][])('%s = %s accepted: %s', (field, value, accepted) => {
      const state = makeState();
      const before = state[field];
      applyPushedState(state, { [field]: value }, asHost);
      expect(state[field]).toBe(accepted ? value : before);
    });

    it('rejects non-numeric config values', () => {
      const state = makeState();
      applyPushedState(state, { winningScore: '9000' }, asHost);
      expect(state.winningScore).toBe(6000);
    });
  });

  describe('field shape checks', () => {
    it('initialCards: accepts a valid deck, rejects an invalid one', () => {
      const state = makeState();
      applyPushedState(state, { initialCards: { Stop: 3 } }, asHost);
      expect(state.initialCards).toEqual({ Stop: 3 });
      applyPushedState(state, { initialCards: { Bogus: 3 } }, asHost);
      expect(state.initialCards).toEqual({ Stop: 3 });
    });

    it('status: rejects values other than lobby/playing', () => {
      const state = makeState();
      applyPushedState(state, { status: 'hacked' }, asHost);
      expect(state.status).toBe('lobby');
    });

    it('randomOrder: rejects non-boolean', () => {
      const state = makeState();
      applyPushedState(state, { randomOrder: 1 }, asHost);
      expect(state.randomOrder).toBe(true);
    });

    it('enforcedDiceMode: accepts null and both dice modes, rejects junk', () => {
      const state = makeState();
      applyPushedState(state, { enforcedDiceMode: 'digital' }, asHost);
      expect(state.enforcedDiceMode).toBe('digital');
      applyPushedState(state, { enforcedDiceMode: 'physical' }, asHost);
      expect(state.enforcedDiceMode).toBe('physical');
      applyPushedState(state, { enforcedDiceMode: 'bogus' }, asHost);
      expect(state.enforcedDiceMode).toBe('physical');
      applyPushedState(state, { enforcedDiceMode: null }, asHost);
      expect(state.enforcedDiceMode).toBeNull();
    });

    it('ruleset: accepts both rule sets from the host while the write is allowed', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'classic' }, asHost);
      expect(state.ruleset).toBe('classic');
      applyPushedState(state, { ruleset: 'modernized' }, asHost);
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: rejects junk even while the write is allowed', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'official' }, asHost);
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: refuses a mid-game write', () => {
      // A mid-game host push must not be able to flip the rules under an
      // active game. Written as the SCENARIO: this used to pass a lobby state
      // and simply omit the (then-explicit) allow flag, so it proved the
      // parameter was read and nothing about the case it is named for.
      const state = makeState();
      state.status = 'playing';
      state.currentPlayerIndex = 0;
      applyPushedState(state, { ruleset: 'classic' }, asHost);
      expect(state.ruleset).toBe('modernized');
    });

    it('ruleset: never accepted from the active player, allowed or not', () => {
      const state = makeState();
      applyPushedState(state, { ruleset: 'classic' }, asActivePlayer);
      expect(state.ruleset).toBe('modernized');
    });

    it('refuses every lobby-only config field mid-game, the set updateConfig refuses', () => {
      // updateConfig has enforced this since it was written, and says so at
      // length: a stray or malicious mid-game event must not flip the win
      // condition or rebuild the deck under an active game. pushState reaches
      // every one of those same fields and enforced it for `ruleset` alone --
      // so the guard was one config path wide, and the other five were a
      // rename away from a running game changing its own rules.
      const state = makeState();
      state.status = 'playing';
      state.currentPlayerIndex = 0;

      applyPushedState(state, {
        winningScore: 7777,
        initialCards: { Stop: 1 },
        randomOrder: false,
        enforcedDiceMode: 'digital',
        reconnectTimeout: 30,
        ruleset: 'classic',
      }, asHost);

      expect(state.winningScore, 'the win condition moved under a running game').toBe(6000);
      expect(state.initialCards.Stop, 'the deck was rebuilt under a running game').toBe(10);
      expect(state.randomOrder).toBe(true);
      expect(state.enforcedDiceMode).toBeNull();
      expect(state.reconnectTimeout).toBe(60);
      expect(state.ruleset).toBe('modernized');
    });

    it('still lets the host cancel a pending expiry mid-game with turnDuration', () => {
      // The one deliberate exception, on this path and in updateConfig alike:
      // shortening the turn to 0 mid-turn cancels a pending expiry. No UI
      // exposes it; the server supports it intentionally (turnTimer.test.ts).
      const state = makeState();
      state.status = 'playing';
      state.currentPlayerIndex = 0;

      applyPushedState(state, { turnDuration: 0 }, asHost);

      expect(state.turnDuration).toBe(0);
    });

    it('still lets the game-starting push carry the config it was started with', () => {
      // Play Again never passes through the lobby: the room is still 'playing'
      // with finished=true when the host pushes the next game's opening state,
      // and that push carries its own config. Refusing it here would silently
      // start the new game on the previous one's settings.
      const state = makeState();
      state.status = 'playing';
      state.finished = true;

      applyPushedState(state, {
        status: 'playing', finished: false, currentPlayerIndex: 0,
        winningScore: 7777, ruleset: 'classic',
      }, { ...asHost, startingGame: true });

      expect(state.winningScore).toBe(7777);
      expect(state.ruleset).toBe('classic');
    });

    it('reconnectTimeout: holds the push path to the range updateConfig accepts', () => {
      // 1..9 is the hole in the range: neither "disabled" (0) nor an accepted
      // duration (>= MIN_ENABLED_RECONNECT_TIMEOUT). The lobby snaps a typed
      // value up out of it (snapDisableableDuration) and updateConfig refuses
      // it outright -- but the push path measured only the outer numeric
      // bounds, so a 3 landed and armed a 3-second kick timer no UI can make.
      const state = makeState();

      applyPushedState(state, { reconnectTimeout: 3 }, asHost);
      expect(state.reconnectTimeout, 'a duration inside the disabled/enabled hole').toBe(60);

      applyPushedState(state, { reconnectTimeout: 0 }, asHost);
      expect(state.reconnectTimeout, 'disabled is a supported lobby option').toBe(0);

      applyPushedState(state, { reconnectTimeout: MIN_ENABLED_RECONNECT_TIMEOUT }, asHost);
      expect(state.reconnectTimeout).toBe(MIN_ENABLED_RECONNECT_TIMEOUT);
    });

    it('currentCard/previousCard: accepts null and valid cards, rejects junk', () => {
      const state = makeState();
      applyPushedState(state, { currentCard: 'Stop', previousCard: 'x2' }, asActivePlayer);
      expect(state.currentCard).toBe('Stop');
      expect(state.previousCard).toBe('x2');
      applyPushedState(state, { currentCard: 'NotACard', previousCard: null }, asActivePlayer);
      expect(state.currentCard).toBe('Stop');
      expect(state.previousCard).toBeNull();
    });

    it('cards: enforces card validity and the deck-size cap', () => {
      const state = makeState();
      applyPushedState(state, { cards: ['Stop', '200'] }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
      applyPushedState(state, { cards: ['Bogus'] }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
      applyPushedState(state, { cards: Array(99 * 11 + 1).fill('Stop') }, asActivePlayer);
      expect(state.cards).toEqual(['Stop', '200']);
    });

    it('currentPlayerIndex: accepts null and in-range integers only', () => {
      const state = makeState();
      applyPushedState(state, { currentPlayerIndex: 1 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: 2 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: -1 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: 0.5 }, asActivePlayer);
      expect(state.currentPlayerIndex).toBe(1);
      applyPushedState(state, { currentPlayerIndex: null }, asActivePlayer);
      expect(state.currentPlayerIndex).toBeNull();
    });

    it('round: integer within [1, cap]', () => {
      const state = makeState();
      applyPushedState(state, { round: 2 }, asActivePlayer);
      expect(state.round).toBe(2);
      for (const bad of [0, 100001, 2.5, 'x']) {
        applyPushedState(state, { round: bad }, asActivePlayer);
        expect(state.round).toBe(2);
      }
    });

    // MAX_ROUNDS is an array-length safety cap, not a bound on a legitimate
    // round number, and nothing related the pushed value to the current one.
    // So an active player could push round: 100000 on their own turn; the
    // HONEST host then submits it as longestGameRounds, sanitizeStats' 1e9 cap
    // waves it through, and the column is MAX-merged into the global row
    // forever. The game plays on normally, so nothing looks wrong until the
    // end screen.
    describe('round only moves as far as a game can move it', () => {
      it('refuses a jump beyond the next round', () => {
        const state = makeState();
        state.round = 4;

        applyPushedState(state, { round: 100000 }, asActivePlayer);
        expect(state.round).toBe(4);

        applyPushedState(state, { round: 6 }, asActivePlayer);
        expect(state.round).toBe(4);
      });

      it('accepts the round ending, a resend, and a correction back', () => {
        const state = makeState();
        state.round = 4;

        applyPushedState(state, { round: 5 }, asActivePlayer);
        expect(state.round, 'the round ends').toBe(5);

        applyPushedState(state, { round: 5 }, asActivePlayer);
        expect(state.round, 'every other push resends the same value').toBe(5);

        applyPushedState(state, { round: 4 }, asActivePlayer);
        expect(state.round, 'an undo puts it back').toBe(4);
      });

      it('lets the host set it freely, since a Play Again resets it to 1', () => {
        const state = makeState();
        state.round = 9;

        applyPushedState(state, { round: 1 }, asHost);

        expect(state.round).toBe(1);
      });
    });

    // Both stats handlers treat room.state.finished as proof a real game
    // ended, and reason about the risk as host-only. But `finished` is an
    // ACTIVE-player field with no game-over check, so any seated player could
    // end the table's game on their own turn: every honest client's listener
    // then fires sendOnlineStats, and each victim's device row takes
    // gamesPlayed + 1 with wins: 0 — which resets their win streak.
    describe('finished needs a game that is actually over', () => {
      const winning = (state: RoomState, name: string): void => {
        const p = state.players.find(q => q.name === name)!;
        p.score = state.winningScore;
      };

      it('refuses to end a game nobody has won', () => {
        const state = makeState();
        state.status = 'playing';

        applyPushedState(state, { finished: true }, asActivePlayer);

        expect(state.finished).toBe(false);
      });

      it('refuses when the leaders are tied on the winning score', () => {
        // The same rule calculateNextTurn and handleActivePlayerRemoved use:
        // a tie is not a win, it is another round.
        const state = makeState();
        winning(state, 'Alice');
        winning(state, 'Bob');

        applyPushedState(state, { finished: true }, asActivePlayer);

        expect(state.finished).toBe(false);
      });

      it('accepts the winner ending their own game', () => {
        const state = makeState();

        applyPushedState(state, {
          players: [{ name: 'Alice', score: state.winningScore }, { name: 'Bob', score: 100 }],
          finished: true,
        }, asActivePlayer);

        expect(state.finished).toBe(true);
      });

      it('reads the roster the same push carries, not the one before it', () => {
        // finished used to be evaluated before players in the field loop, so
        // the winning score arrived after the decision that needed it.
        const state = makeState();
        expect(state.players[0].score).toBe(0);

        applyPushedState(state, {
          finished: true,
          players: [{ name: 'Alice', score: state.winningScore }, { name: 'Bob' }],
        }, asActivePlayer);

        expect(state.finished).toBe(true);
      });

      it('always lets a game be un-finished again, which is what Play Again does', () => {
        const state = makeState();
        state.finished = true;

        applyPushedState(state, { finished: false }, asActivePlayer);

        expect(state.finished).toBe(false);
      });

      it('holds the host to the same rule — a tie is not a win', () => {
        // The host used to be exempt, so a host client whose engine had
        // drifted (or a patched one) could freeze a verdict with TWO winners:
        // rememberFinishedGame takes getLeaders() at face value, and both
        // names then take a win and a fastestWinTurns that can never be undone.
        const state = makeState();
        state.status = 'playing';
        winning(state, 'Alice');
        winning(state, 'Bob');

        applyPushedState(state, { finished: true }, asHost);

        expect(state.finished).toBe(false);
      });

      it('refuses a host finish for a game nobody has won', () => {
        const state = makeState();
        state.status = 'playing';

        applyPushedState(state, { finished: true }, asHost);

        expect(state.finished).toBe(false);
      });

      it('accepts the host push that ends a game a sole leader has won', () => {
        const state = makeState();
        state.status = 'playing';

        applyPushedState(state, {
          players: [{ name: 'Alice', score: state.winningScore }, { name: 'Bob', score: 100 }],
          finished: true,
          currentPlayerIndex: null,
        }, asHost);

        expect(state.finished).toBe(true);
        expect(state.currentPlayerIndex).toBeNull();
      });

      it('accepts the host ending the game early — gameSlice.endGame pushes finished: false', () => {
        // The only explicit early-end the UI offers (GameControls' "End Game",
        // host-only online) tears the game down to the LOBBY: finished stays
        // false and no verdict is ever frozen. So nothing legitimate needs the
        // old host exemption.
        const state = makeState();
        Object.assign(state, { status: 'playing', currentPlayerIndex: 0 });

        applyPushedState(state, {
          status: 'lobby', finished: false, currentPlayerIndex: null, round: 1,
          chartValues: [], chartNames: [], chartLabels: [],
        }, asHost);

        expect(state.status).toBe('lobby');
        expect(state.finished).toBe(false);
        expect(state.currentPlayerIndex).toBeNull();
      });
    });

    it('finished: boolean only', () => {
      const state = makeState();
      applyPushedState(state, { finished: 'true' }, asActivePlayer);
      expect(state.finished).toBe(false);
    });

    it('previousScore: null or magnitude-capped finite number', () => {
      const state = makeState();
      applyPushedState(state, { previousScore: -350 }, asActivePlayer);
      expect(state.previousScore).toBe(-350);
      applyPushedState(state, { previousScore: 1_000_001 }, asActivePlayer);
      expect(state.previousScore).toBe(-350);
      applyPushedState(state, { previousScore: null }, asActivePlayer);
      expect(state.previousScore).toBeNull();
    });

    it('previousLeaders: null, or plausible snapshots capped at player count', () => {
      const state = makeState();
      applyPushedState(state, { previousLeaders: [{ name: 'Alice', score: 100 }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: [{ name: 'A', score: 1 }, { name: 'B', score: 2 }, { name: 'C', score: 3 }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: [{ name: 'Alice' }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      applyPushedState(state, { previousLeaders: null }, asActivePlayer);
      expect(state.previousLeaders).toBeNull();
    });

    it('previousLeaders: rejects an entry with an over-long name or an absurd score', () => {
      // These entries ride every subsequent broadcast, so one push planting a
      // megabyte-long name or a 1e308 score would re-send it to every client
      // for the rest of the game — the same hole chartNames' cap closed.
      const state = makeState();
      applyPushedState(state, { previousLeaders: [{ name: 'Alice', score: 100 }] }, asActivePlayer);
      for (const bad of [{ name: 'x'.repeat(31), score: 1 }, { name: '', score: 1 }, { name: 'Alice', score: 1e308 }, { name: 'Alice', score: -1_000_001 }]) {
        applyPushedState(state, { previousLeaders: [bad] }, asActivePlayer);
        expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
      }
      applyPushedState(state, { previousLeaders: [{ name: 'x'.repeat(30), score: 1_000_000 }] }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'x'.repeat(30), score: 1_000_000 }]);
    });

    it('previousLeaders: strips fields beyond name/score from each entry', () => {
      // isPlausiblePlayerSnapshot only shape-checks name/score — without
      // rebuilding the entries, an extra property would ride along into
      // every future broadcast of previousLeaders.
      const state = makeState();
      applyPushedState(state, {
        previousLeaders: [{ name: 'Alice', score: 100, deviceId: 'HIJACK', extra: 'junk' }],
      }, asActivePlayer);
      expect(state.previousLeaders).toEqual([{ name: 'Alice', score: 100 }]);
    });

    // grep found this key in no server test at all, while socketSlice puts it
    // in every real push. Deleting the branch ships green and every remote
    // client silently falls back to the score comparison the source itself
    // flags as wrong.
    it('previousWasSuccess: boolean only', () => {
      const state = makeState();
      applyPushedState(state, { previousWasSuccess: true }, asActivePlayer);
      expect(state.previousWasSuccess).toBe(true);
      applyPushedState(state, { previousWasSuccess: 1 }, asActivePlayer);
      expect(state.previousWasSuccess).toBe(true);
      applyPushedState(state, { previousWasSuccess: false }, asActivePlayer);
      expect(state.previousWasSuccess).toBe(false);
    });

    it('previousWasBust: boolean only', () => {
      const state = makeState();
      applyPushedState(state, { previousWasBust: true }, asActivePlayer);
      expect(state.previousWasBust).toBe(true);
      applyPushedState(state, { previousWasBust: 1 }, asActivePlayer);
      expect(state.previousWasBust).toBe(true);
    });

    it('previousHighestTurnScore: non-negative magnitude-capped number', () => {
      const state = makeState();
      applyPushedState(state, { previousHighestTurnScore: 900 }, asActivePlayer);
      expect(state.previousHighestTurnScore).toBe(900);
      for (const bad of [-1, 1_000_001, NaN]) {
        applyPushedState(state, { previousHighestTurnScore: bad }, asActivePlayer);
        expect(state.previousHighestTurnScore).toBe(900);
      }
    });

    it('previousHighestFeuerwerkTurnScore/previousHighestX2TurnScore: non-negative magnitude-capped numbers', () => {
      const state = makeState();
      applyPushedState(state, { previousHighestFeuerwerkTurnScore: 900, previousHighestX2TurnScore: 700 }, asActivePlayer);
      expect(state.previousHighestFeuerwerkTurnScore).toBe(900);
      expect(state.previousHighestX2TurnScore).toBe(700);
      for (const bad of [-1, 1_000_001, NaN]) {
        applyPushedState(state, { previousHighestFeuerwerkTurnScore: bad, previousHighestX2TurnScore: bad }, asActivePlayer);
        expect(state.previousHighestFeuerwerkTurnScore).toBe(900);
        expect(state.previousHighestX2TurnScore).toBe(700);
      }
    });

    it('previousPlayerName: null or a non-empty string up to 30 chars', () => {
      const state = makeState();
      applyPushedState(state, { previousPlayerName: 'Alice' }, asActivePlayer);
      expect(state.previousPlayerName).toBe('Alice');
      applyPushedState(state, { previousPlayerName: null }, asActivePlayer);
      expect(state.previousPlayerName).toBeNull();
      applyPushedState(state, { previousPlayerName: 'Bob' }, asActivePlayer);
      for (const bad of ['', 'x'.repeat(31), 123, undefined]) {
        applyPushedState(state, { previousPlayerName: bad }, asActivePlayer);
        expect(state.previousPlayerName).toBe('Bob');
      }
    });

    it('chartValues: one finite-number array per player', () => {
      const state = makeState();
      applyPushedState(state, { chartValues: [[100], [200]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[1]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[NaN], [2]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
    });

    // These were the last pushed numerics settling for finiteness alone —
    // exactly what isBoundedNumber exists to stop a new field doing. The
    // series rides every later broadcast and is what the end screen plots, so
    // one 1e308 entry is re-sent to the whole room until the game ends.
    it('chartValues: bounded like every other pushed score', () => {
      const state = makeState();
      applyPushedState(state, { chartValues: [[100], [200]] }, asActivePlayer);

      applyPushedState(state, { chartValues: [[MAX_SCORE_MAGNITUDE + 1], [2]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);
      applyPushedState(state, { chartValues: [[-MAX_SCORE_MAGNITUDE - 1], [2]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[100], [200]]);

      // The bound itself is still accepted, and so is a legitimately negative
      // running total (modernized Plus/Minus deductions are unclamped).
      applyPushedState(state, { chartValues: [[MAX_SCORE_MAGNITUDE], [-500]] }, asActivePlayer);
      expect(state.chartValues).toEqual([[MAX_SCORE_MAGNITUDE], [-500]]);
    });

    it('chartNames: one non-empty string per player, capped at name length', () => {
      const state = makeState();
      applyPushedState(state, { chartNames: ['Alice', 'Bob'] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'Bob']);
      // These are player names, so they follow the same 1-30 char rule as
      // previousPlayerName/historyLog — without the cap this was the one
      // client-pushed string the server stored unbounded and re-broadcast to
      // every client on each subsequent state change.
      for (const bad of [['Alice', 42], ['Alice', ''], ['Alice', 'x'.repeat(31)]]) {
        applyPushedState(state, { chartNames: bad }, asActivePlayer);
        expect(state.chartNames).toEqual(['Alice', 'Bob']);
      }
      applyPushedState(state, { chartNames: ['Alice', 'x'.repeat(30)] }, asActivePlayer);
      expect(state.chartNames).toEqual(['Alice', 'x'.repeat(30)]);
    });

    it('clears the whole chart trio when the host ends the game', () => {
      // endGame pushes the trio empty together, with the roster untouched.
      // chartValues/chartNames are length-tied to that roster, so [] was
      // refused for both while chartLabels: [] sailed through -- leaving the
      // room holding the finished game's series under no round labels at all,
      // re-broadcast on every emitRoomState (which overwrites the host's own
      // cleared copy) and inherited by the next game started from that lobby.
      const state = makeState();
      applyPushedState(state, {
        chartValues: [[100], [200]], chartNames: ['Alice', 'Bob'], chartLabels: [1],
      }, asActivePlayer);

      applyPushedState(state, {
        status: 'lobby', finished: false, currentPlayerIndex: null,
        chartValues: [], chartNames: [], chartLabels: [],
      }, asHost);

      expect(state.chartLabels).toEqual([]);
      expect(state.chartValues, "the finished game's series outlived its labels").toEqual([]);
      expect(state.chartNames, "the finished game's names outlived its labels").toEqual([]);
    });

    it('chartLabels: finite numbers within the rounds cap', () => {
      const state = makeState();
      applyPushedState(state, { chartLabels: [1, 2] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);
      applyPushedState(state, { chartLabels: [1, 'x'] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);
    });

    // Labels are round numbers — there is no round 2.5, and no round 1e308.
    it('chartLabels: whole round numbers, bounded like the values', () => {
      const state = makeState();
      applyPushedState(state, { chartLabels: [1, 2] }, asActivePlayer);

      applyPushedState(state, { chartLabels: [1, 2.5] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);
      applyPushedState(state, { chartLabels: [1, MAX_SCORE_MAGNITUDE + 1] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2]);

      applyPushedState(state, { chartLabels: [1, 2, 3] }, asActivePlayer);
      expect(state.chartLabels).toEqual([1, 2, 3]);
    });

    it('gameTimeInSeconds: non-negative capped number', () => {
      const state = makeState();
      applyPushedState(state, { gameTimeInSeconds: 42 }, asActivePlayer);
      expect(state.gameTimeInSeconds).toBe(42);
      for (const bad of [-1, 10_000_001, NaN]) {
        applyPushedState(state, { gameTimeInSeconds: bad }, asActivePlayer);
        expect(state.gameTimeInSeconds).toBe(42);
      }
    });

    it('liveTurnState: null or a valid dice snapshot', () => {
      const state = makeState();
      const snapshot = { turnScore: 100, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };
      applyPushedState(state, { liveTurnState: snapshot }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, keptDice: Array(7).fill({}) } }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: null }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
    });

    it('liveTurnState: rejects a snapshot whose dice elements are malformed', () => {
      // A spectator's client renders keptDice/currentRoll entries' `.val`
      // directly into JSX — a malformed element reaching a broadcast crashes
      // every viewer's render. The whole snapshot must be rejected (keeping
      // the last good one), not merged in with a bad element left inside.
      const state = makeState();
      const snapshot = { turnScore: 100, tuttosThisTurn: 0, keptDice: [{ id: 'd1', val: 4 }], currentRoll: [], kniffelProgress: [] };
      applyPushedState(state, { liveTurnState: snapshot }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);

      applyPushedState(state, { liveTurnState: { ...snapshot, keptDice: [{ id: 'd1', val: 'boom' }] } }, asActivePlayer);
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, currentRoll: [{ id: 'd2', val: 3 }] } }, asActivePlayer); // missing `selected`
      expect(state.liveTurnState).toEqual(snapshot);
      applyPushedState(state, { liveTurnState: { ...snapshot, kniffelProgress: [0] } }, asActivePlayer); // out of 1-6 range
      expect(state.liveTurnState).toEqual(snapshot);
    });

    it('liveTurnState: rejects a malformed rollingDiceIds/busted, accepts well-formed ones', () => {
      const state = makeState();
      const snapshot = { turnScore: 0, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };

      // createRoom() initializes liveTurnState to null — a rejected push
      // leaves that untouched (RT-1: the field is required, always one of
      // DiceSnapshot | null, never undefined).
      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: [123] } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: Array(7).fill('d1') } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();
      applyPushedState(state, { liveTurnState: { ...snapshot, busted: 'yes' } }, asActivePlayer);
      expect(state.liveTurnState).toBeNull();

      applyPushedState(state, { liveTurnState: { ...snapshot, rollingDiceIds: ['d1', 'd2'], busted: true } }, asActivePlayer);
      expect(state.liveTurnState).toEqual({ ...snapshot, rollingDiceIds: ['d1', 'd2'], busted: true });
    });

    it('liveTurnState: strips fields beyond the known snapshot shape', () => {
      // Every field is shape-checked, but a valid snapshot with an extra
      // property attached would otherwise still be stored (and rebroadcast)
      // as-is — the same class of hole isValidDiceSnapshot exists to close.
      const state = makeState();
      applyPushedState(state, {
        liveTurnState: {
          turnScore: 50, tuttosThisTurn: 0,
          keptDice: [{ id: 'd1', val: 4, extra: 'junk' }],
          currentRoll: [{ id: 'd2', val: 2, selected: true, extra: 'junk' }],
          kniffelProgress: [],
          maliciousField: { toString: () => 'boom' },
        },
      }, asActivePlayer);
      expect(state.liveTurnState).toEqual({
        turnScore: 50, tuttosThisTurn: 0,
        keptDice: [{ id: 'd1', val: 4 }],
        currentRoll: [{ id: 'd2', val: 2, selected: true }],
        kniffelProgress: [],
      });
    });

    it('historyLog: validates and sanitizes pushed history log', () => {
      const state = makeState();
      const validEntry = {
        id: '1-Alice-1',
        round: 1,
        playerName: 'Alice',
        card: 'x2',
        type: 'success',
        score: 1000,
        playerColor: '#ffffff',
      };

      // Valid push
      applyPushedState(state, { historyLog: [validEntry] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid field: score too large
      applyPushedState(state, { historyLog: [{ ...validEntry, score: 2_000_000 }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]); // should reject and keep valid

      // Invalid type
      applyPushedState(state, { historyLog: [{ ...validEntry, type: 'cheated' }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid card type
      applyPushedState(state, { historyLog: [{ ...validEntry, card: 'SuperCard' }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Invalid player name length
      applyPushedState(state, { historyLog: [{ ...validEntry, playerName: 'a'.repeat(31) }] }, asActivePlayer);
      expect(state.historyLog).toEqual([validEntry]);

      // Valid optional deducted players
      const validPlusMinus = {
        id: '2-Bob-3',
        round: 2,
        playerName: 'Bob',
        card: 'Plus_Minus',
        type: 'success',
        score: 1000,
        deductedPlayers: ['Alice'],
      };
      applyPushedState(state, { historyLog: [validPlusMinus] }, asActivePlayer);
      expect(state.historyLog).toEqual([validPlusMinus]);
    });
  });
});

describe('validateInitialCards', () => {
  it('rejects non-objects, empty objects, unknown keys, and out-of-range counts', () => {
    expect(validateInitialCards(null)).toBe(false);
    expect(validateInitialCards('deck')).toBe(false);
    expect(validateInitialCards({})).toBe(false);
    expect(validateInitialCards({ Bogus: 1 })).toBe(false);
    expect(validateInitialCards({ Stop: -1 })).toBe(false);
    expect(validateInitialCards({ Stop: 100 })).toBe(false);
    expect(validateInitialCards({ Stop: 1.5 })).toBe(false);
  });

  it('rejects an all-zero deck and accepts a playable one', () => {
    expect(validateInitialCards({ Stop: 0, x2: 0 })).toBe(false);
    expect(validateInitialCards({ Stop: 0, x2: 1 })).toBe(true);
  });
});

describe('applyValidatedConfig', () => {
  it('applies only the fields that pass validation', () => {
    const state = makeState();
    applyValidatedConfig(state, {
      winningScore: 7777,      // valid
      turnDuration: 5,         // below minimum — ignored
      reconnectTimeout: 0,     // valid ("off")
      randomOrder: 'yes',      // not boolean — ignored
      initialCards: { Stop: 2 }, // valid
      enforcedDiceMode: 'digital', // valid
      ruleset: 'classic',      // valid
    });
    expect(state.winningScore).toBe(7777);
    expect(state.turnDuration).toBe(120);
    expect(state.reconnectTimeout).toBe(0);
    expect(state.randomOrder).toBe(true);
    expect(state.initialCards).toEqual({ Stop: 2 });
    expect(state.enforcedDiceMode).toBe('digital');
    expect(state.ruleset).toBe('classic');
  });

  it('ignores an invalid ruleset value', () => {
    const state = makeState();
    applyValidatedConfig(state, { ruleset: 'bogus' });
    expect(state.ruleset).toBe('modernized');
  });

  it('applies enforcedDiceMode: null (turning enforcement back off)', () => {
    const state = makeState();
    state.enforcedDiceMode = 'digital';
    applyValidatedConfig(state, { enforcedDiceMode: null });
    expect(state.enforcedDiceMode).toBeNull();
  });

  it('ignores an invalid enforcedDiceMode value', () => {
    const state = makeState();
    applyValidatedConfig(state, { enforcedDiceMode: 'bogus' });
    expect(state.enforcedDiceMode).toBeNull();
  });
});

describe('validatePushedPlayers', () => {
  const existing = [makePlayer('Alice'), makePlayer('Bob')];

  it('accepts a same-length list of known names', () => {
    expect(validatePushedPlayers(existing, [{ name: 'Bob' }, { name: 'Alice' }])).toBe(true);
  });

  it('rejects non-arrays, wrong lengths, unknown names, and null entries', () => {
    expect(validatePushedPlayers(existing, 'players' as unknown as unknown[])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }, { name: 'Eve' }])).toBe(false);
    expect(validatePushedPlayers(existing, [{ name: 'Alice' }, null])).toBe(false);
  });

  it('rejects a pushed list with duplicate names, even if every name is otherwise known (SERVER-PV-1)', () => {
    expect(validatePushedPlayers(existing, [{ name: 'Bob' }, { name: 'Bob' }])).toBe(false);
  });
});

describe('MAX_SCORE_MAGNITUDE: client and server share one ceiling', () => {
  // A physical score box used to cap length alone (7 digits, up to 9,999,999)
  // while this server-side bound was 1,000,000 — also 7 digits, so the length
  // cap never caught the gap. The server then dropped score/previousScore
  // field-wise but applied everything else pushed alongside them, silently
  // desyncing the two sides (and handing Undo the wrong forfeited amount).
  // Both re-export the SAME constant from src/utils/configValidation.ts now
  // (see this file's own MAX_SCORE_MAGNITUDE re-export), so this pins the
  // value itself — a future edit to just one side's import would still leave
  // them equal in code but wrong in effect if the shared constant were ever
  // duplicated back out into two.
  it('parseScoreInput (the client clamp) never exceeds this file\'s MAX_SCORE_MAGNITUDE', async () => {
    const { parseScoreInput } = await import('../src/utils/diceTurnControls');
    expect(parseScoreInput(String(MAX_SCORE_MAGNITUDE))).toBe(MAX_SCORE_MAGNITUDE);
    expect(parseScoreInput(String(MAX_SCORE_MAGNITUDE + 1))).toBe(MAX_SCORE_MAGNITUDE);
    expect(parseScoreInput('9999999')).toBe(MAX_SCORE_MAGNITUDE);
  });

  it('is imported from the shared client/server module, not redefined here', async () => {
    const { MAX_SCORE_MAGNITUDE: clientSideConstant } = await import('../src/utils/configValidation');
    expect(MAX_SCORE_MAGNITUDE).toBe(clientSideConstant);
  });
});

describe('isPlausiblePlayerSnapshot', () => {
  it('requires an object with a string name and finite numeric score', () => {
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: 1 })).toBe(true);
    expect(isPlausiblePlayerSnapshot(null)).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A' })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 1, score: 1 })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: NaN })).toBe(false);
  });

  it('bounds the name length and the score magnitude, like every other pushed name/score', () => {
    expect(isPlausiblePlayerSnapshot({ name: 'x'.repeat(30), score: 1_000_000 })).toBe(true);
    expect(isPlausiblePlayerSnapshot({ name: 'x'.repeat(31), score: 1 })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: '', score: 1 })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: 1_000_001 })).toBe(false);
    expect(isPlausiblePlayerSnapshot({ name: 'A', score: -1_000_001 })).toBe(false);
  });
});

describe('isValidDiceSnapshot', () => {
  const valid = { turnScore: 0, tuttosThisTurn: 0, keptDice: [], currentRoll: [], kniffelProgress: [] };

  it('accepts a minimal valid snapshot', () => {
    expect(isValidDiceSnapshot(valid)).toBe(true);
  });

  it('rejects non-objects, non-finite scores, and over-long arrays', () => {
    expect(isValidDiceSnapshot(null)).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, turnScore: NaN })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, tuttosThisTurn: Infinity })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, keptDice: Array(7).fill(0) })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, currentRoll: Array(7).fill(0) })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: Array(7).fill(0) })).toBe(false);
  });

  it('rejects scores past the magnitude cap every other numeric field enforces', () => {
    // turnScore was finiteness-checked only, while every sibling numeric in
    // this file is bounded by MAX_SCORE_MAGNITUDE. The timeout path launders
    // it onto a player's permanent record: the liveTurnState handler accepts
    // isHost || isActivePlayer, so a patched host can plant a snapshot for
    // someone ELSE's turn, force expiry, and turnTimers writes it to their
    // highestForfeitedTurnScore — which that player's own unmodified client
    // then submits for their device, where the DB merges it with MAX.
    expect(isValidDiceSnapshot({ ...valid, turnScore: 1e308 })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, turnScore: -1e308 })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, turnScore: MAX_SCORE_MAGNITUDE })).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, tuttosThisTurn: 1e308 })).toBe(false);
  });

  it('accepts well-formed dice/kniffel-progress elements', () => {
    expect(isValidDiceSnapshot({
      ...valid,
      keptDice: [{ id: 'd1', val: 6 }],
      currentRoll: [{ id: 'd2', val: 3, selected: true }, { id: 'd3', val: 1, selected: false }],
      kniffelProgress: [1, 2, 3],
    })).toBe(true);
  });

  it('rejects malformed keptDice elements', () => {
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 'not-a-number' }] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1' }] })).toBe(false); // missing val
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ val: 4 }] })).toBe(false); // missing id
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 123, val: 4 }] })).toBe(false); // id not a string
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 0 }] })).toBe(false); // val out of 1-6
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 7 }] })).toBe(false); // val out of 1-6
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'd1', val: 3.5 }] })).toBe(false); // non-integer
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: '', val: 3 }] })).toBe(false); // empty id
    expect(isValidDiceSnapshot({ ...valid, keptDice: [{ id: 'x'.repeat(65), val: 3 }] })).toBe(false); // id too long
    expect(isValidDiceSnapshot({ ...valid, keptDice: ['not-an-object'] })).toBe(false);
  });

  it('rejects malformed currentRoll elements', () => {
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 3 }] })).toBe(false); // missing selected
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 3, selected: 'yes' }] })).toBe(false); // selected not boolean
    expect(isValidDiceSnapshot({ ...valid, currentRoll: [{ id: 'd1', val: 9, selected: true }] })).toBe(false); // val out of range
  });

  it('rejects malformed kniffelProgress entries', () => {
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [0] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [7] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: ['1'] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, kniffelProgress: [1.5] })).toBe(false);
  });

  it('accepts a well-formed optional busted/rollingDiceIds, or their absence', () => {
    expect(isValidDiceSnapshot(valid)).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, busted: true })).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: ['d1', 'd2'] })).toBe(true);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [] })).toBe(true);
  });

  it('rejects a malformed optional busted/rollingDiceIds', () => {
    expect(isValidDiceSnapshot({ ...valid, busted: 'yes' })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: 'd1' })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [123] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: [''] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: ['x'.repeat(65)] })).toBe(false);
    expect(isValidDiceSnapshot({ ...valid, rollingDiceIds: Array(7).fill('d1') })).toBe(false);
  });
});

describe('classic chain fields (snapshot / history / turn summary)', () => {
  const validSnapshot: DiceSnapshot = {
    turnScore: 100,
    keptDice: [{ id: 'd1', val: 1 }],
    currentRoll: [{ id: 'd2', val: 5, selected: false }],
    kniffelProgress: [],
    tuttosThisTurn: 0,
  };

  it('accepts and copies optional chain fields on a dice snapshot', () => {
    // Annotated (rather than inferred) so cardsThisTurn's literals are
    // checked against CardType instead of widening to string[] — a typo'd
    // card name here would otherwise pass sanitizeDiceSnapshot's parameter
    // check and only fail, confusingly, deep inside the function.
    const withChain: DiceSnapshot = {
      ...validSnapshot,
      cardsThisTurn: ['300', 'x2'],
      plusMinusScores: [1800],
      chainTuttoCount: 2,
    };
    expect(isValidDiceSnapshot(withChain)).toBe(true);
    const clean = sanitizeDiceSnapshot(withChain);
    expect(clean.cardsThisTurn).toEqual(['300', 'x2']);
    expect(clean.plusMinusScores).toEqual([1800]);
    expect(clean.chainTuttoCount).toBe(2);
    // Still absent when not sent — old clients keep working.
    expect(sanitizeDiceSnapshot(validSnapshot).cardsThisTurn).toBeUndefined();
  });

  it('rejects malformed chain fields on a dice snapshot', () => {
    expect(isValidDiceSnapshot({ ...validSnapshot, cardsThisTurn: ['NotACard'] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, cardsThisTurn: Array(101).fill('200') })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, plusMinusScores: [-1] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, plusMinusScores: 1 })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, chainTuttoCount: 1.5 })).toBe(false);
    // The Stop & Score marker — a boolean like busted, or nothing.
    expect(isValidDiceSnapshot({ ...validSnapshot, stopped: true })).toBe(true);
    expect(isValidDiceSnapshot({ ...validSnapshot, stopped: 'yes' })).toBe(false);
    expect(sanitizeDiceSnapshot({ ...validSnapshot, stopped: true } as never).stopped).toBe(true);
  });

  const validSummary = {
    cards: [{ card: '300', completed: true }, { card: 'Stop', completed: false }],
    tuttoCount: 1,
    plusMinusScores: [],
    ended: 'stopCard',
  };

  it('validates and sanitizes a turn summary', () => {
    expect(isValidTurnSummary(validSummary)).toBe(true);
    // 'timeout' is server-produced (turnTimers), but the committed summary
    // rides every later pushState round-trip — rejecting it here would strip
    // the previous turn's summary and break undoing a timed-out chain.
    expect(isValidTurnSummary({ ...validSummary, ended: 'timeout' })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, ended: 'later' })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, cards: [{ card: 'Nope', completed: true }] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, tuttoCount: -1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: [''] })).toBe(false);

    const withExtra = { ...validSummary, deductedPlayers: ['Bob', 'Bob'], junk: 'x' };
    const clean = sanitizeTurnSummary(withExtra as never);
    expect(clean).toEqual({ ...validSummary, deductedPlayers: ['Bob', 'Bob'] });
    expect('junk' in clean).toBe(false);
  });

  // The shape checks are shared with the two local caches (src/utils/turnShapes.ts);
  // these bounds are the network's own, and must not follow them out of this file.
  it('keeps the bounds that only untrusted input needs', () => {
    expect(isValidTurnSummary({ ...validSummary, forfeitedScore: 1_000_000 })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, forfeitedScore: 1_000_001 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, prevMostCardsInTurn: 1_000_001 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, prevHighestForfeitedTurnScore: 1_000_001 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['x'.repeat(30)] })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['x'.repeat(31)] })).toBe(false);
    // The engine adds each Plus/Minus running total to a player's score, so an
    // unbounded entry off the wire would be an unbounded score.
    expect(isValidTurnSummary({ ...validSummary, plusMinusScores: [1_000_000] })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, plusMinusScores: [1_000_001] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, plusMinusScores: [0, -1] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, plusMinusScores: 2 })).toBe(false);
  });

  // What the classic 0-floor actually took, one entry per name in
  // deductedPlayers. The activity log reads the two lists BY INDEX
  // (summarizeDeductions), so a pair that cannot be read that way is worse
  // than none at all — and a field the sanitizer drops never reaches the other
  // clients, who would then see the flat 1000 the sender does not.
  const deductedPair = { deductedPlayers: ['Bob'], deductedAmounts: [400] };

  it('carries the per-deduction amounts through a turn summary', () => {
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair })).toBe(true);
    // Absent stays valid: the modernized path records none, and a client
    // predating the field sends none.
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'] })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: [0] })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: [1_000_000] })).toBe(true);

    // The sanitizer rebuilds the summary from a fixed field list — without the
    // field there, the amounts are stripped off every relayed push.
    const clean = sanitizeTurnSummary({ ...validSummary, ...deductedPair } as never);
    expect(clean).toEqual({ ...validSummary, ...deductedPair });
  });

  it('rejects deduction amounts that cannot be read alongside the names', () => {
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: [400, 400] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedAmounts: [400] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: ['400'] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: [-1] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: [1_000_001] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: [NaN] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, ...deductedPair, deductedAmounts: 400 })).toBe(false);
  });

  it('lets the active player push previousTurnSummary, validated and sanitized', () => {
    const state = makeState();
    applyPushedState(state, { previousTurnSummary: { ...validSummary, junk: 'x' } }, asActivePlayer);
    expect(state.previousTurnSummary).toEqual(validSummary);
    applyPushedState(state, { previousTurnSummary: null }, asActivePlayer);
    expect(state.previousTurnSummary).toBeNull();
    applyPushedState(state, { previousTurnSummary: { ...validSummary, ended: 'bogus' } }, asActivePlayer);
    expect(state.previousTurnSummary).toBeNull(); // invalid → ignored
  });

  // sanitizeTurnSummary rebuilds the summary field by field, and these two
  // copies were at coverage count 0: the only tests naming them were
  // isValidTurnSummary bound checks, which never reach applyPushedState.
  // Deleting either ships green — and then an undone classic online turn
  // leaves the record inflated for good, because calculateUndo's restore is
  // keyed on the field being present at all.
  it('carries the per-turn record restores through a real push, not just past the validator', () => {
    const state = makeState();
    const withRestores = {
      ...validSummary,
      forfeitedScore: 1800,
      prevMostCardsInTurn: 4,
      prevHighestForfeitedTurnScore: 2500,
    };

    applyPushedState(state, { previousTurnSummary: withRestores }, asActivePlayer);

    // toEqual, not toMatchObject: a dropped field is exactly the defect, and
    // toMatchObject would not see it.
    expect(state.previousTurnSummary).toEqual(withRestores);
  });

  it('keeps a null record restore, which means "there was no record"', () => {
    // undefined means "the client said nothing"; null means "restore it to
    // nothing". Collapsing the two would make an undo re-instate a record the
    // turn had actually set from scratch.
    const state = makeState();
    const clearing = { ...validSummary, prevMostCardsInTurn: null, prevHighestForfeitedTurnScore: null };

    applyPushedState(state, { previousTurnSummary: clearing }, asActivePlayer);

    expect(state.previousTurnSummary).toEqual(clearing);
  });

  // The log is rendered straight into JSX for every client in the room, and
  // four of isValidHistoryEntry's guards had no test at all: id, round,
  // playerColor and deductedPlayers. Deleting any of them shipped green.
  // Driven one field at a time off a known-good entry, so each case fails for
  // its own reason.
  describe('history entry fields with no test of their own', () => {
    const good = {
      id: '1-Alice-1', round: 2, playerName: 'Alice', card: '300',
      type: 'success', score: 300,
    };

    const rejects = (overrides: Record<string, unknown>): boolean => {
      const state = makeState();
      state.historyLog = [];
      applyPushedState(state, { historyLog: [{ ...good, ...overrides }] }, asActivePlayer);
      return state.historyLog.length === 0;
    };

    it('accepts the known-good entry, so the cases below fail for their field', () => {
      expect(rejects({})).toBe(false);
    });

    it.each([
      ['id missing', { id: undefined }],
      ['id empty', { id: '' }],
      ['id absurdly long', { id: 'x'.repeat(101) }],
      ['id not a string', { id: 7 }],
    ])('rejects an entry whose %s', (_name, override) => {
      expect(rejects(override)).toBe(true);
    });

    it.each([
      ['round zero', { round: 0 }],
      ['round fractional', { round: 2.5 }],
      ['round past the cap', { round: 100001 }],
      ['round not a number', { round: '2' }],
    ])('rejects an entry with %s', (_name, override) => {
      expect(rejects(override)).toBe(true);
    });

    it.each([
      ['a colour that is not a hex triplet', { playerColor: 'red' }],
      ['a short hex colour', { playerColor: '#fff' }],
      ['a colour that is not a string', { playerColor: 0xff0000 }],
    ])('rejects %s', (_name, override) => {
      expect(rejects(override)).toBe(true);
    });

    it('accepts a well-formed player colour, and an absent one', () => {
      expect(rejects({ playerColor: '#12ab34' })).toBe(false);
      expect(rejects({ playerColor: undefined })).toBe(false);
    });

    it.each([
      ['deductedPlayers not an array', { deductedPlayers: 'Bob' }],
      ['a deducted name that is empty', { deductedPlayers: [''] }],
      ['a deducted name that is not a string', { deductedPlayers: [{ name: 'Bob' }] }],
      ['a deducted name past the length cap', { deductedPlayers: ['x'.repeat(31)] }],
      ['more deducted names than a table can hold', { deductedPlayers: Array.from({ length: 101 }, (_, i) => `P${i}`) }],
    ])('rejects %s', (_name, override) => {
      expect(rejects(override)).toBe(true);
    });

    // The 'type' field's own valid set is now HISTORY_EVENT_TYPES
    // (src/types.ts) rather than a hand-rolled copy in this file — a member
    // added there (like 'timeout', for a server-clock forfeit) used to
    // type-check everywhere while this validator silently rejected it off
    // the wire, dropping the whole history entry from every OTHER client.
    it.each(['success', 'bust', 'skip', 'fail', 'timeout'])('accepts type %s', (type) => {
      expect(rejects({ type })).toBe(false);
    });

    it.each([
      ['an unknown string', { type: 'timeout_bogus' }],
      ['not a string', { type: 3 }],
      ['missing', { type: undefined }],
    ])('rejects a type that is %s', (_name, override) => {
      expect(rejects(override)).toBe(true);
    });
  });

  it('accepts a history entry carrying a chain card list, and strips a bad one', () => {
    const state = makeState();
    const entry = {
      id: '1-Alice-1', round: 1, playerName: 'Alice', card: '300',
      type: 'success', score: 2800, cards: ['300', 'Kniffel'],
    };
    applyPushedState(state, { historyLog: [entry] }, asActivePlayer);
    expect(state.historyLog).toHaveLength(1);
    expect(state.historyLog[0].cards).toEqual(['300', 'Kniffel']);

    applyPushedState(state, { historyLog: [{ ...entry, cards: ['NotACard'] }] }, asActivePlayer);
    // The malformed entry is rejected, so the log keeps its previous value.
    expect(state.historyLog[0].cards).toEqual(['300', 'Kniffel']);
  });

  // Same rule as the turn summary above, on the entry the activity log renders
  // directly: the player who took the turn sees the clamped amount from their
  // own engine, so a field stripped here means everyone ELSE reads the flat
  // 1000 for a hit that took 400.
  it('relays the amount a clamped deduction really took on a history entry', () => {
    const state = makeState();
    const entry = {
      id: '1-Alice-1', round: 1, playerName: 'Alice', card: 'Plus_Minus',
      type: 'success', score: 1000,
      ...deductedPair,
    };
    applyPushedState(state, { historyLog: [entry] }, asActivePlayer);
    expect(state.historyLog[0].deductedAmounts).toEqual([400]);

    // Read by index, so a misaligned or non-numeric pair is rejected whole —
    // the log keeps the last entry it accepted.
    applyPushedState(state, { historyLog: [{ ...entry, deductedAmounts: [400, 400] }] }, asActivePlayer);
    expect(state.historyLog[0].deductedAmounts).toEqual([400]);
    applyPushedState(state, { historyLog: [{ ...entry, deductedAmounts: ['400'] }] }, asActivePlayer);
    expect(state.historyLog[0].deductedAmounts).toEqual([400]);
    applyPushedState(state, { historyLog: [{ ...entry, deductedAmounts: [1_000_001] }] }, asActivePlayer);
    expect(state.historyLog[0].deductedAmounts).toEqual([400]);

    // An entry from a client predating the field keeps working, amount-free.
    applyPushedState(state, { historyLog: [{ ...entry, deductedAmounts: undefined }] }, asActivePlayer);
    expect(state.historyLog[0].deductedAmounts).toBeUndefined();
    expect(state.historyLog[0].deductedPlayers).toEqual(['Bob']);
  });
});
