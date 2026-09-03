import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface UseTurnAnnouncementOptions {
  isOnline: boolean;
  isMyTurn: boolean;
  /** The store action behind App.tsx's existing polite toast live region —
   *  reused here rather than standing up a second announcer. */
  addToast: (message: string) => void;
}

/**
 * "It's your turn" for an online game, spoken through the same polite live
 * region the toasts already use (App.tsx's ToastMessage). Fires once per
 * false-to-true transition of isMyTurn — the same edge-detection Game.tsx
 * already runs for the your-turn haptic (see wasMyTurnRef there) — so a
 * player mid-turn who re-renders for an unrelated reason isn't told twice,
 * and loading straight into an already-mine turn (a fresh join, a reconnect)
 * says nothing either.
 *
 * Local hot-seat has no meaning for "your turn": every turn is "mine" there,
 * since one device is passed around the table — announcing it would just be
 * noise on every single turn.
 */
export const useTurnAnnouncement = ({ isOnline, isMyTurn, addToast }: UseTurnAnnouncementOptions): void => {
  const { t } = useTranslation();
  const wasMyTurnRef = useRef(!!isMyTurn);

  useEffect(() => {
    if (isOnline && isMyTurn && !wasMyTurnRef.current) {
      addToast(t('game.yourTurn'));
    }
    wasMyTurnRef.current = !!isMyTurn;
  }, [isOnline, isMyTurn, addToast, t]);
};
