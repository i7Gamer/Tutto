/**
 * Upper bound on one Engine.IO packet's raw byte size, checked BEFORE it is
 * ever decoded — the only defence at that layer; everything pushState
 * carries is validated field-by-field afterward in pushValidation.ts, with
 * its own per-field caps (MAX_HISTORY_LOG_SIZE, MAX_CHAIN_CARDS,
 * MAX_DECK_SIZE, ...), but decoding a many-megabyte packet to reach those
 * checks is itself a cost a client can otherwise inflict for free. The same
 * Server-level option also governs outgoing gameState broadcasts — socket.io
 * drops the connection on either side's oversize packet, so this must fit
 * the largest state a real game can legitimately produce, not just what a
 * client may legitimately send.
 *
 * Previously left unset (the engine.io library default), which happened to
 * be big enough for legitimate traffic but was never actually chosen for
 * that reason and could silently shrink or grow on a socket.io upgrade.
 *
 * Sized from a measured worst case (see the "maximal pushed/broadcast state"
 * test in pushStateValidation.test.ts): a full MAX_PLAYERS_PER_ROOM (100)
 * roster, historyLog trimmed to MAX_HISTORY_LOG_SIZE (50) entries each
 * holding a maximal MAX_CHAIN_CARDS (100) classic chain and deduction list, a
 * fully-drawn 1,089-card deck (MAX_CARD_COUNT × the 11 card types), and chart
 * history out to REALISTIC_MAX_ROUNDS rounds (see that test) comes out to a
 * few hundred KiB — over the previous 512 KiB cap, which would have made a
 * room that ever reached that size unplayable (every broadcast dropped
 * instead of delivered). Kept as a round power-of-two-ish value with real
 * headroom over the measurement (that test asserts on the margin directly),
 * rather than the measurement itself, so a small change to any of those caps
 * doesn't need this constant touched too.
 */
export const MAX_PUSHED_STATE_BYTES = 1024 * 1024; // 1 MiB
