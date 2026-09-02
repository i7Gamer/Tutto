// Duration of the card-flip animation that GameControls plays whenever a new
// card is revealed. Game.tsx delays the Stop-card buzzer and the Feuerwerk
// confetti by the same amount so they land once the flip has finished — the
// two must stay in sync or the effects fire mid-flip.
export const CARD_FLIP_MS = 1200;

// How long the Stop card stays on screen (after the flip) before the turn
// auto-advances for the active online player.
export const STOP_CARD_AUTO_CONTINUE_MS = 5000;

// HelpPopup's collapsible sections use framer-motion's default tween (300ms)
// to animate open. Scrolling a highlighted card into view must wait until
// that finishes, otherwise it scrolls against a height that is still
// animating and can land short of the final position.
export const HELP_SECTION_OPEN_ANIMATION_MS = 350;

// The dice-roll panel's entrance also uses framer-motion's default tween
// (300ms). Game.tsx waits this long before telling DiceGame it's safe to
// auto-roll, so the dice don't start tumbling while the panel itself is still
// animating in.
export const DICE_PANEL_ENTRANCE_MS = 350;

// How long a join attempt may stay pending before its caller gives up.
// joinRoom only resolves on the server's ack, and socket.io buffers the emit
// while the server is unreachable — without this deadline the promise may
// never settle. Shared by the lobby's join button and the reconnect popup's
// "Yes, Reconnect", which race it against the join for the same reason.
export const JOIN_TIMEOUT_MS = 10_000;

// How long after a reconnect an 'unauthorized' pushState refusal is read as a
// race with this client's own rejoin rather than a real authorization failure.
//
// The two are indistinguishable from the reason alone: the server refuses a
// push from a socket that holds no seat, and for the first round trip after a
// transport drop that is exactly what a legitimate host looks like. Inside
// this window the push is retried once; outside it the refusal is taken at
// face value. Generous next to a rejoin round trip, far short of the shortest
// turn timer a lobby can configure.
export const PUSH_REJOIN_RACE_WINDOW_MS = 5_000;

// How long that single retry waits for the rejoin to settle server-side before
// re-sending the same snapshot. One short round trip — long enough that the
// joinRoom the ack just answered has finished its own bookkeeping, short
// enough that the move is not visibly late.
export const PUSH_REJOIN_RETRY_DELAY_MS = 300;

// How long a resolved dice turn's summary counts down before auto-continuing
// to the next player. The countdown logic (useAutoContinueCountdown) and the
// summary's shrinking progress bar (DiceSummary) both derive from this one
// value — as two separate literals they could silently drift apart.
export const AUTO_CONTINUE_SECONDS = 3;

// DiceGame roll animation: every die tumbles for DIE_TUMBLE_MS, then settles
// one after another, each DIE_STAGGER_MS after the previous. While tumbling,
// a die's shown face is re-randomized every DIE_FACE_SHUFFLE_MS. The roll is
// finalized (bust check, summary) ROLL_SETTLE_BUFFER_MS after the last die
// settles, so the outcome never flashes in while a die still appears to move.
export const DIE_TUMBLE_MS = 400;
export const DIE_STAGGER_MS = 150;
export const DIE_FACE_SHUFFLE_MS = 80;
export const ROLL_SETTLE_BUFFER_MS = 100;

// After a bust the final dice stay on screen this long before the summary
// overlay replaces them, so the player can see what they actually rolled.
export const BUST_SUMMARY_DELAY_MS = 1500;

// Live dice snapshots for spectators are debounced by this much between
// state changes (see DiceGame's onStateChange effect) — one frame per pause
// in the action instead of one per keystroke-level state change.
export const LIVE_SNAPSHOT_DEBOUNCE_MS = 300;

// How long a toast stays up before it removes itself. Long enough to read a
// short sentence, short enough that a burst of them (a run of players joining)
// does not queue up into a wall.
export const TOAST_LIFETIME_MS = 3000;

// Backstop for a classic mid-chain draw whose card never arrives through
// DiceGame's currentCard prop: how long the deferred chain roll waits before
// the draw is treated as never having happened.
//
// The push that carries a mid-chain draw can be discarded server side —
// applyPushedState's roster bail-out, or the socket-identity gate when a
// transport blip means the sender's socket is no longer the seat's socketId.
// The next room state then reverts currentCard (a GAME_STATE_SYNC_KEY) to the
// card that was drawn FROM, which the release guard can never be satisfied by
// again: the roll would stay parked forever behind an empty table whose every
// button is disabled, on a panel that is deliberately non-dismissible. A
// revert that lands on that same card changes no prop and so wakes nothing —
// only this deadline is left. (A revert that does change it is caught the
// moment it arrives; see DiceGame's discarded-draw effect.)
//
// Generous next to a round trip (and to the socket.io reconnect one of those
// blips implies), well inside the shortest turn timer that can be configured.
export const DISCARDED_DRAW_RECOVERY_MS = 5000;

// ErrorBoundary throttles its automatic crash recovery: a crash within this
// many ms of the previous one skips straight to the fallback UI instead of
// reloading again, so a persistent render crash cannot loop forever. Long
// enough that a reload plus the app re-mounting comfortably finishes inside
// it; short enough that two genuinely unrelated crashes minutes apart both
// still get an automatic recovery attempt.
export const CRASH_LOOP_WINDOW_MS = 10_000;

// Lobby reorder buttons defer the actual swap: on mobile, swapping the rows
// synchronously re-renders while the tap's hover/active state is still held,
// leaving that highlight stuck on a DIFFERENT row's button after the press.
// The short delay lets the browser release the pressed state first.
export const REORDER_PRESS_RELEASE_MS = 50;
