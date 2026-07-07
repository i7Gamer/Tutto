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
