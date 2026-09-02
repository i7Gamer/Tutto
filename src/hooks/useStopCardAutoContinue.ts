import { useEffect } from 'react';
import { playBuzzer } from '../utils/soundEffects';
import { CARD_FLIP_MS, STOP_CARD_AUTO_CONTINUE_MS } from '../utils/uiTimings';
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
 */
export const useStopCardAutoContinue = ({
  currentCard,
  cardsLength,
  isOnline,
  isMyTurn,
  showDiceGame,
  onAutoContinue,
}: UseStopCardAutoContinueOptions): void => {
  useEffect(() => {
    let soundTimeout: ReturnType<typeof setTimeout> | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;

    // A Stop drawn while the dice modal is open is a classic chain forfeit
    // that DiceGame itself commits (with its own summary) — the auto-continue
    // here would race it and commit the turn a second time.
    if (currentCard === 'Stop' && !showDiceGame) {
      soundTimeout = setTimeout(() => playBuzzer(), CARD_FLIP_MS);
      if (isOnline && isMyTurn) {
        turnTimeout = setTimeout(onAutoContinue, CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS);
      }
    }

    return () => {
      clearTimeout(soundTimeout);
      clearTimeout(turnTimeout);
    };
  }, [isOnline, isMyTurn, currentCard, cardsLength, showDiceGame, onAutoContinue]);
};
