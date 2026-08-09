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

// Lobby reorder buttons defer the actual swap: on mobile, swapping the rows
// synchronously re-renders while the tap's hover/active state is still held,
// leaving that highlight stuck on a DIFFERENT row's button after the press.
// The short delay lets the browser release the pressed state first.
export const REORDER_PRESS_RELEASE_MS = 50;
