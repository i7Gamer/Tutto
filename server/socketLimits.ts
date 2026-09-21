/**
 * Upper bound on one Engine.IO packet's raw byte size, checked BEFORE it is
 * ever decoded — the only defence at that layer. pushState payloads are
 * validated by the application handler/action parser afterward, but decoding a
 * many-megabyte packet to reach those checks is itself a cost a client can
 * otherwise inflict for free.
 *
 * This is socket.io's `maxHttpBufferSize` Server option, which bounds
 * INCOMING packets only — the size of one message a client sends to the
 * server, checked at the transport layer before it is ever parsed. It does
 * NOT bound outgoing gameState broadcasts: socket.io does not check, and
 * does not drop the connection over, an oversize packet the SERVER sends.
 * (Confirmed directly: a 1.4 MB broadcast reached a real client with no
 * disconnect.) An outgoing broadcast can still legitimately exceed this
 * constant — this only needs to fit what a legitimate CLIENT PUSH may
 * contain, not the full state the server may later broadcast.
 *
 * Previously left unset (the engine.io library default), which happened to
 * be big enough for legitimate traffic but was never actually chosen for
 * that reason and could silently shrink or grow on a socket.io upgrade.
 *
 * Current pushState commands send action/base/mutationId plus an empty
 * `newState` object, but the server must still tolerate cached or rolled-back
 * v2 clients that send the historical full object envelope. Oversized raw
 * fixtures therefore stay at the transport boundary, and representative
 * legacy/current client packet measurements — not outgoing broadcast size —
 * are the data this incoming cap should be compared against. Kept at 1 MiB
 * during the envelope reduction until a separate cap change is justified
 * across all accepted client events.
 */
export const MAX_PUSHED_STATE_BYTES = 1024 * 1024; // 1 MiB
