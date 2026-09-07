import { useTranslation } from 'react-i18next';

export interface RollAnnouncement {
  key: string;
  values: Record<string, unknown>;
}

interface RollAnnouncerProps {
  announcement: RollAnnouncement | null;
  // Bumped by useRollAnnouncement's caller once per landed roll — see the
  // remount comment below.
  seq: number;
}

/**
 * The screen-reader voice for a landed roll (useRollAnnouncement.ts feeds
 * it). Precedent: ReactionOverlay.tsx's own role="status" live region — but
 * that precedent does not solve "the same sentence twice in a row is not
 * re-spoken": a live region only announces on a DOM mutation, and setting
 * identical text is not one. Keying the announced content on `seq`, which
 * increments on every call, forces a remount (a synchronous DOM
 * teardown/recreate) instead of relying on a clear-then-set timer.
 *
 * Named with its own aria-label, like ReactionOverlay's: CurrentRollBoard's
 * invalid-selection line and App.tsx's toast region are both role="status"
 * too, and two anonymous status regions are indistinguishable in a screen
 * reader's region list.
 */
export default function RollAnnouncer({ announcement, seq }: RollAnnouncerProps) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" aria-label={t('dice.announce.live', 'Roll results')} className="sr-only">
      {announcement && <span key={seq}>{t(announcement.key, announcement.values)}</span>}
    </div>
  );
}
