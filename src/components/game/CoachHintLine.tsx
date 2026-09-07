import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import type { CoachHint } from '../../utils/coachHint';

interface CoachHintLineProps {
  hint: CoachHint | null;
}

// Die values read better as a plain comma list than a locale-formatted one
// here — the same choice HistoryLog.tsx makes for its own chains, and this
// line is never more than a handful of dice.
const KEEP_SEPARATOR = ', ';

/**
 * Otto's advice under the roll board — "Ask Otto" — rendered only while
 * coachHintEnabled is on, only for the acting human's own panel (see
 * DiceGame.tsx). Never a live region: feature A's roll announcer already
 * speaks the landed roll, and this line is read on demand, not pushed at
 * anyone.
 */
export default function CoachHintLine({ hint }: CoachHintLineProps) {
  const { t } = useTranslation();

  if (!hint) return null;

  const keep = hint.keep.join(KEEP_SEPARATOR);
  // Otto's own arithmetic is a mean over many outcomes, not a number a table
  // will ever actually show — rounded here, for display only; coachHint.ts
  // keeps the exact figures for whatever reads them next. Both are null
  // exactly when action isn't 'roll' (S-3), the only branch that reads them.
  const rollValue = hint.rollValue === null ? null : Math.round(hint.rollValue);
  const threshold = hint.threshold === null ? null : Math.round(hint.threshold);

  // A completed card offers no roll (available.roll is false), so coachHint
  // hands back null bust figures rather than quoting risk for a roll that was
  // never on offer (S-3) — the stop copy drops that clause entirely then,
  // instead of interpolating nulls into the sentence.
  const message = hint.action === 'roll'
    ? t(
        'coach.roll',
        'Otto would keep {{keep}} and roll {{dice}} dice: {{bust}}% bust risk, rolling is worth {{rollValue}} against {{threshold}} for banking.',
        { keep, dice: hint.diceAfter, bust: hint.bustPercent, rollValue, threshold },
      )
    : hint.action === 'stop'
      ? (hint.bustPercent === null
        ? t('coach.stopNoRoll', 'Otto would keep {{keep}} and bank {{bank}}.', { keep, bank: hint.bank })
        : t(
            'coach.stop',
            'Otto would keep {{keep}} and bank {{bank}}: {{bust}}% bust risk on {{dice}} dice.',
            { keep, bank: hint.bank, bust: hint.bustPercent, dice: hint.diceAfter },
          ))
      : t('coach.draw', 'Otto would draw the next card with {{bank}} at stake.', { bank: hint.bank });

  return (
    <p className="mt-4 flex items-start gap-2 text-sm text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl px-4 py-3">
      <Lightbulb size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        {hint.selectionDiffers && (
          <span>{t('coach.selectionDiffers', 'Otto would keep different dice. ')}</span>
        )}
        <span>{message}</span>
        {hint.trailing && (
          <span> {t('coach.trailing', 'You are behind, so Otto accepts more risk.')}</span>
        )}
      </span>
    </p>
  );
}
