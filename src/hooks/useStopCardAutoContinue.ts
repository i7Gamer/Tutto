import { useEffect, useState } from 'react';
import { playBuzzer } from '../utils/soundEffects';
import { CARD_FLIP_MS, STOP_CARD_AUTO_CONTINUE_MS, STOP_CARD_AUTO_CONTINUE_SECONDS } from '../utils/uiTimings';
import { useAutoContinueCountdown } from './useAutoContinueCountdown';
import type { CardType } from '../types';

export interface UseStopCardAutoContinueOptions {
  currentCard: CardType | null;
  /**
   * Deliberate and not incidental: drawing another Stop card leaves
   * currentCard unchanged, and the deck shrinking is what tells the two draws
   * apart so the buzzer sounds again for the second one.
   */
  cardsLength: number | undefined;
  isOnline: boolean;
  isMyTurn: boolean;
  showDiceGame: boolean;
  /**
   * Commit the turn the Stop card ended. Only ever called for the active
   * ONLINE player — a local game waits for the Continue button instead, since
   * nobody else is being kept waiting. Give it a stable identity: it sits in
   * this hook's effect dependency array.
   */
  onAutoContinue: () => void;
}

/**
 * What a Stop card does on its own once it has finished flipping: the buzzer
 * for everyone watching, and — online, for the seat whose turn it just ended —
 * the turn advancing by itself a few seconds later, so a disconnected or
 * distracted player cannot stall the table on a card that offers no choice.
 *
 * Both timers are torn down if anything about the card, the deck or the seat
 * changes first, so a card that comes and goes inside the delay never fires.
 *
 * Returns the seconds left before that auto-continue, once armed — the same
 * shape useAutoContinueCountdown gives the dice summary's "Continuing in
 * N…" bar, so the Stop card can show the same cue instead of advancing
 * silently. It is display-only: the turnTimeout above stays the one thing
 * that actually commits the turn, so a stale countdown left over from a
 * torn-down seat can never fire onAutoContinue a second time.
 */
export const useStopCardAutoContinue = ({
  currentCard,
  cardsLength,
  isOnline,
  isMyTurn,
  showDiceGame,
  onAutoContinue,
}: UseStopCardAutoContinueOptions): number | null => {
  // A Stop drawn while the dice modal is open is a classic chain forfeit
  // that DiceGame itself commits (with its own summary) — the auto-continue
  // here would race it and commit the turn a second time.
  const armed = currentCard === 'Stop' && !showDiceGame;

  useEffect(() => {
    let soundTimeout: ReturnType<typeof setTimeout> | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;

    if (armed) {
      soundTimeout = setTimeout(() => playBuzzer(), CARD_FLIP_MS);
      if (isOnline && isMyTurn) {
        turnTimeout = setTimeout(onAutoContinue, CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS);
      }
    }

    return () => {
      clearTimeout(soundTimeout);
      clearTimeout(turnTimeout);
    };
  }, [armed, isOnline, isMyTurn, cardsLength, onAutoContinue]);

  // The visible countdown waits out the same flip delay the buzzer/turn
  // timers above do, so it never starts ticking while the card is still
  // rotating in.
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setFlipped(true), CARD_FLIP_MS);
    // Runs on the way out too — armed going false (or a new Stop replacing
    // this one) resets flipped so a stale "true" from the last card can never
    // leak into the next shouldStart.
    return () => {
      clearTimeout(id);
      setFlipped(false);
    };
  }, [armed, cardsLength]);

  return useAutoContinueCountdown({
    shouldStart: flipped && isOnline && isMyTurn,
    seconds: STOP_CARD_AUTO_CONTINUE_SECONDS,
    // No-op: the turnTimeout in the effect above is the single thing allowed
    // to actually commit the turn (see the doc comment). This hook exists
    // only to drive the on-screen countdown.
    onElapsed: () => {},
    restartKey: cardsLength,
  });
};
