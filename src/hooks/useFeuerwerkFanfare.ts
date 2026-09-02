import { useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';
import { playSuccess } from '../utils/soundEffects';
import { CARD_FLIP_MS } from '../utils/uiTimings';
import type { CardType } from '../types';

// The burst itself: enough pieces to read as a celebration on a phone screen,
// thrown wide, from just below the middle of the viewport so it rises past the
// card that earned it rather than starting off-screen.
const FANFARE_PARTICLE_COUNT = 150;
const FANFARE_SPREAD_DEGREES = 80;
const FANFARE_ORIGIN_Y = 0.6;

/**
 * The confetti-and-chime celebration a Feuerwerk card gets, once its flip has
 * finished. Fires at most once per drawn card: the latch resets whenever the
 * card or the deck size changes, so drawing a SECOND Feuerwerk (which leaves
 * currentCard untouched) still celebrates, while a re-render on the same card
 * does not celebrate twice.
 *
 * The latch is re-checked inside the timer as well as outside it — the reset
 * effect and this one both run on the same dependencies, and the check that
 * matters is the one at the moment the burst would actually happen.
 */
export const useFeuerwerkFanfare = (currentCard: CardType | null, cardsLength: number | undefined): void => {
  const confettiFiredRef = useRef(false);

  useEffect(() => {
    confettiFiredRef.current = false;
  }, [currentCard, cardsLength]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (currentCard === 'Feuerwerk' && !confettiFiredRef.current) {
      timeout = setTimeout(() => {
        if (!confettiFiredRef.current) {
          confetti({
            particleCount: FANFARE_PARTICLE_COUNT,
            spread: FANFARE_SPREAD_DEGREES,
            origin: { y: FANFARE_ORIGIN_Y },
          });
          playSuccess();
          confettiFiredRef.current = true;
        }
      }, CARD_FLIP_MS);
    }
    return () => clearTimeout(timeout);
  }, [currentCard, cardsLength]);
};
