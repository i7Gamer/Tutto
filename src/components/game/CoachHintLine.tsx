import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import type { CoachHint } from '../../utils/coachHint';
import { formatInt } from '../../utils/formatNumber';

interface CoachHintLineProps {
  hint: CoachHint | null;
}

// Die values read better as a plain comma list than a locale-formatted one
// here — the same choice HistoryLog.tsx makes for its own chains, and this
// line is never more than a handful of dice.
const KEEP_SEPARATOR = ', ';

/** One translated sentence: the key, the copy it falls back to, and its values. */
interface Message {
  key: string;
  fallback: string;
  values: Record<string, unknown>;
}

/**
 * Which sentence this table's advice is. Otto may only ever describe a move
 * the panel is offering: the banking comparison is dropped when the Stop
 * button is not there to press (coachHint nulls both figures then), and a
 * Kleeblatt's Stop is named for what it does — roll the second tutto, or
 * finish the card and win — instead of a bank that cannot happen.
 *
 * Written as statements rather than one nested ternary because there are now
 * seven of them, and the pair that matters most (rollNoBank, secondTutto) is
 * the pair a ternary chain buries deepest.
 */
const messageFor = (hint: CoachHint, keep: string, language: string): Message => {
  const bank = formatInt(Math.round(hint.bank), language);
  if (hint.reason === 'bankWin') {
    return {
      key: 'coach.bankWin',
      fallback: 'Otto would keep {{keep}} and bank {{bank}} to win the game.',
      values: { keep, bank },
    };
  }

  if (hint.reason === 'avoidLoss') {
    if (hint.action === 'draw') {
      return {
        key: 'coach.avoidLossDraw',
        fallback: 'Otto would keep {{keep}} and draw the next card to avoid losing the game.',
        values: { keep },
      };
    }
    return {
      key: 'coach.avoidLossRoll',
      fallback: 'Otto would keep {{keep}} and roll on to avoid losing the game.',
      values: { keep },
    };
  }

  if (hint.action === 'draw') {
    return {
      key: 'coach.draw',
      fallback: 'Otto would draw the next card with {{bank}} at stake.',
      values: { bank },
    };
  }

  if (hint.action === 'stop') {
    if (hint.stopMeans === 'secondTutto') {
      return { key: 'coach.secondTutto', fallback: 'Otto would keep {{keep}} and roll the second tutto.', values: { keep } };
    }
    if (hint.stopMeans === 'winGame') {
      return { key: 'coach.winGame', fallback: 'Otto would keep {{keep}} and finish the card to win the game.', values: { keep } };
    }
    // A completed card offers no roll (available.roll is false), so coachHint
    // hands back a null bust risk rather than quoting one for a roll that was
    // never on offer (S-3) — the copy drops that clause entirely then.
    if (hint.bustPercent === null) {
      return { key: 'coach.stopNoRoll', fallback: 'Otto would keep {{keep}} and bank {{bank}}.', values: { keep, bank } };
    }
    return {
      key: 'coach.stop',
      fallback: 'Otto would keep {{keep}} and bank {{bank}} rather than risk a {{bust}}% bust on {{dice}} dice.',
      values: { keep, bank, bust: hint.bustPercent, dice: hint.diceAfter },
    };
  }

  const rollValues = { keep, dice: hint.diceAfter, bust: hint.bustPercent };
  // Null exactly when the panel is not offering the bank this roll would be
  // measured against (Kniffel, Plus/Minus and Kleeblatt before the card is
  // complete; Feuerwerk always). Advise the roll on its own there.
  if (hint.rollValue === null || hint.threshold === null) {
    return {
      key: 'coach.rollNoBank',
      fallback: 'Otto would keep {{keep}} and roll {{dice}} dice: {{bust}}% bust risk.',
      values: rollValues,
    };
  }

  // Otto's own arithmetic is a mean over many outcomes, not a number a table
  // will ever actually show — rounded here, for display only; coachHint keeps
  // the exact figures for whatever reads them next.
  const rollValue = Math.round(hint.rollValue);
  if (rollValue === Math.round(hint.bank)) {
    return {
      key: 'coach.rollTie',
      fallback: 'Otto would keep {{keep}} and roll {{dice}} dice: {{bust}}% bust risk, and rolling is worth about as much as banking.',
      values: rollValues,
    };
  }
  return {
    key: 'coach.roll',
    fallback: 'Otto would keep {{keep}} and roll {{dice}} dice: {{bust}}% bust risk, rolling is worth {{rollValue}} against {{bank}} for banking.',
    values: { ...rollValues, rollValue: formatInt(rollValue, language), bank },
  };
};

/**
 * Otto's advice under the roll board — "Ask Otto" — rendered only while
 * coachHintEnabled is on, only for the acting human's own panel (see
 * DiceGame.tsx). Never a live region: feature A's roll announcer already
 * speaks the landed roll, and this line is read on demand, not pushed at
 * anyone.
 */
export default function CoachHintLine({ hint }: CoachHintLineProps) {
  const { t, i18n } = useTranslation();

  if (!hint) return null;

  const message = messageFor(hint, hint.keep.join(KEEP_SEPARATOR), i18n.language);

  return (
    <p className="mt-4 flex items-start gap-2 text-sm text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl px-4 py-3">
      <Lightbulb size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        {hint.selectionDiffers && (
          <span>{t('coach.selectionDiffers', 'Your dice differ from Otto\'s. ')}</span>
        )}
        <span>{t(message.key, message.fallback, message.values)}</span>
        {!hint.reason && hint.trailing && (
          <span> {t('coach.trailing', 'You are behind, so Otto accepts more risk.')}</span>
        )}
      </span>
    </p>
  );
}
