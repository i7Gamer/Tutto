// Duration of the card-flip animation that GameControls plays whenever a new
// card is revealed. Game.tsx delays the Stop-card buzzer and the Feuerwerk
// confetti by the same amount so they land once the flip has finished — the
// two must stay in sync or the effects fire mid-flip.
export const CARD_FLIP_MS = 1200;

// How long the Stop card stays on screen (after the flip) before the turn
// auto-advances for the active online player.
export const STOP_CARD_AUTO_CONTINUE_MS = 5000;
