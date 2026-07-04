// Shared between client (reaction picker UI) and server (socketHandlers'
// sendReaction validation) so both sides can never drift.
export const REACTION_EMOJIS = ['👍', '🔥', '😂', '😱', '💀', '🎲'] as const;

// How long a reaction stays on screen before it's pruned from the store.
export const REACTION_DISPLAY_MS = 2500;
