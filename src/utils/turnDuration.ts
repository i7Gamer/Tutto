import type { CardType } from '../types';

// Single source of truth for how long a turn lasts per card. The server
// (authoritative expiry — server/rooms.ts calculateRemainingTurnTime) and the
// client (display countdown — useGameStore.syncOnlineTimers) both derive their
// durations from here so the two can never drift apart.
export const TURN_DURATION_MULTIPLIERS: Partial<Record<CardType, number>> = {
  Feuerwerk: 3,
  Kleeblatt: 2,
};

export const getEffectiveTurnDuration = (card: CardType | null, baseDuration: number): number => {
  const multiplier = card ? (TURN_DURATION_MULTIPLIERS[card] ?? 1) : 1;
  return baseDuration * multiplier;
};
