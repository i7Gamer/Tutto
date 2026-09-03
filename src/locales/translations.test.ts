/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JOIN_ERROR_KEYS } from '../utils/joinErrors';
import { JOIN_REFUSAL_CODES } from '../../server/socketRoomHandlers';

const enPath = path.resolve(__dirname, './en/translation.json');
const dePath = path.resolve(__dirname, './de/translation.json');

const readLocaleKeys = (localePath: string): string[] =>
  Object.keys(JSON.parse(fs.readFileSync(localePath, 'utf8')));

const readLocale = (localePath: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(localePath, 'utf8'));

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      if ((file.endsWith('.ts') || file.endsWith('.tsx')) && !file.includes('.test.')) {
        arrayOfFiles.push(fullPath);
      }
    }
  });

  return arrayOfFiles;
}

describe('Translation Keys Validation', () => {
  it('should have all used translation keys present in both en and de translation.json', () => {
    const srcDir = path.resolve(__dirname, '..');
    const files = getAllFiles(srcDir);
    
    const usedKeys = new Set<string>();
    
    // Match t('key') or t("key") or t(`key`)
    // Must be preceded by non-word char (e.g. space, dot, bracket) to avoid matching "it(...)"
    const regex = /(?:^|[^\w])t\(\s*['"`]([^'"`]+)['"`]/g;

    files.forEach((file) => {
      const content = fs.readFileSync(file, 'utf8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        usedKeys.add(match[1]);
      }
    });

    const enKeys = readLocaleKeys(enPath);
    const deKeys = readLocaleKeys(dePath);

    const missingInEn: string[] = [];
    const missingInDe: string[] = [];

    usedKeys.forEach((key) => {
      if (!enKeys.includes(key)) {
        missingInEn.push(key);
      }
      if (!deKeys.includes(key)) {
        missingInDe.push(key);
      }
    });

    expect(missingInEn, `Missing keys in EN translation: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInDe, `Missing keys in DE translation: ${missingInDe.join(', ')}`).toEqual([]);
  });
});

// The guard above only sees keys written as a literal `t('...')`. The lobby's
// join-refusal keys are reached through a Map (see JOIN_ERROR_KEYS), so they
// were invisible to it — all twelve were absent from both locale files while
// the suite stayed green, and every refusal rendered i18next's fallback, i.e.
// the server's English prose, into a German UI. Enumerating the map closes
// that blind spot.
describe('Join refusal translation keys', () => {
  it('resolves every JOIN_ERROR_KEYS value in both en and de translation.json', () => {
    const enKeys = readLocaleKeys(enPath);
    const deKeys = readLocaleKeys(dePath);

    const mappedKeys = [...JOIN_ERROR_KEYS.values()];
    const missingInEn = mappedKeys.filter((key) => !enKeys.includes(key));
    const missingInDe = mappedKeys.filter((key) => !deKeys.includes(key));

    expect(missingInEn, `Join refusal keys missing in EN translation: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInDe, `Join refusal keys missing in DE translation: ${missingInDe.join(', ')}`).toEqual([]);
  });

  // The test above only guarantees that what the map DOES list is translated.
  // A fifteenth refusal added server-side would still ship untranslated (the
  // lobby falls back to the server's English sentence for a code it does not
  // know), and nothing would say so — hence the equality against the server's
  // own list rather than a subset check in either direction. Sorted copies: the
  // map is ordered by the handler's checks, and that order is not the contract.
  it('maps exactly the refusal codes the server can send', () => {
    expect([...JOIN_ERROR_KEYS.keys()].sort()).toEqual([...JOIN_REFUSAL_CODES].sort());
  });
});

// The engine only ends the game at the END of a round, for a SOLE leader at
// or above the winning score (see coreGameEngine.ts) — a player who reaches
// it first can still lose to someone later in the same round, and a tie
// plays on. Every place that states the win rule in prose used to say "first
// to reach" / "exceed" instead, which describes a different (wrong) game.
// This guards the wording rather than just the keys' existence.
describe('Win rule wording', () => {
  const bannedPatterns = [/exceed/i, /überschreit/i, /first to reach/i, /erste/i];

  const winRuleKeys = [
    // The in-game goal banner (Game.tsx composes goalPrefix + score + goalSuffix).
    'game.goalPrefix', 'game.goalSuffix',
    'help.settings.winningScore',
    'help.general.intro',
  ];

  it.each(winRuleKeys)('%s (en) states the rule without the old wrong wording', (key) => {
    const value = readLocale(enPath)[key];
    bannedPatterns.forEach((pattern) => expect(value).not.toMatch(pattern));
  });

  it.each(winRuleKeys)('%s (de) states the rule without the old wrong wording', (key) => {
    const value = readLocale(dePath)[key];
    bannedPatterns.forEach((pattern) => expect(value).not.toMatch(pattern));
  });

  it('the en banner states the round-end rule', () => {
    const en = readLocale(enPath);
    expect(`${en['game.goalPrefix']} ${en['game.goalSuffix']}`).toMatch(/round/i);
  });

  it('the de banner states the round-end rule', () => {
    const de = readLocale(dePath);
    expect(`${de['game.goalPrefix']} ${de['game.goalSuffix']}`).toMatch(/runde/i);
  });

  it('help.settings.winningScore (en) states the round-end rule', () => {
    expect(readLocale(enPath)['help.settings.winningScore']).toMatch(/round/i);
  });

  it('help.settings.winningScore (de) states the round-end rule', () => {
    expect(readLocale(dePath)['help.settings.winningScore']).toMatch(/runde/i);
  });

  it('help.general.intro (en) states the round-end rule', () => {
    expect(readLocale(enPath)['help.general.intro']).toMatch(/round/i);
  });

  it('help.general.intro (de) states the round-end rule', () => {
    expect(readLocale(dePath)['help.general.intro']).toMatch(/runde/i);
  });

  // Leaderboard.tsx's own t() calls still carried the pre-A1 default strings
  // as their fallback (second) argument, even after the translation VALUES
  // above were corrected — a source no locale file could catch, since a
  // fallback only ever renders when the key itself is missing.
  it('Leaderboard.tsx\'s t() fallbacks for the goal line carry no old wrong wording', () => {
    const leaderboardSource = fs.readFileSync(
      path.resolve(__dirname, '../components/game/Leaderboard.tsx'),
      'utf8',
    );
    bannedPatterns.forEach((pattern) => expect(leaderboardSource).not.toMatch(pattern));
    expect(leaderboardSource).not.toMatch(/wins!/i);
  });
});

// The badge used to say a custom game "will not count toward the
// statistics", contradicting end.customGameNotice/statistics.customGamesExplainer/
// help.statistics.s7 and the README, which all agree custom games ARE
// recorded (just kept out of the lifetime record). Pins the corrected wording.
describe('lobby.customGameNoStats wording', () => {
  it('en says the game is recorded under Custom, not that it goes uncounted', () => {
    const value = readLocale(enPath)['lobby.customGameNoStats'];
    expect(value).toContain('Custom');
    expect(value.toLowerCase()).not.toContain('not count');
  });

  it('de says the game is recorded under "Angepasst", not that it goes uncounted', () => {
    const value = readLocale(dePath)['lobby.customGameNoStats'];
    expect(value).toContain('Angepasst');
    expect(value).not.toMatch(/zählt nicht/i);
    expect(value).not.toMatch(/nicht gezählt/i);
  });
});

// home.restore.cancel actually gives up the seat (App.tsx's restore dialog
// wires it to cancelReconnect, a server leave) but read like a harmless
// dismiss ("No, Cancel") — nothing on the button hinted that declining costs
// the player their spot in the room.
describe('home.restore.cancel wording', () => {
  it('en states that declining leaves the game', () => {
    expect(readLocale(enPath)['home.restore.cancel'].toLowerCase()).toContain('leave');
  });

  it('de states that declining leaves the game', () => {
    expect(readLocale(dePath)['home.restore.cancel']).toMatch(/verlass/i);
  });
});

// Every other bust string in the German file says "Niete" — game.controls.bust
// alone said "Fehlwurf", a different word for the same event nowhere else used
// in the glossary.
describe('German bust glossary consistency', () => {
  it('the German file contains no "Fehlwurf"', () => {
    const de = fs.readFileSync(dePath, 'utf8');
    expect(de).not.toMatch(/Fehlwurf/);
  });
});

describe('Interpolation placeholders match between en and de', () => {
  // Key parity says nothing about {{name}} vs {{player}}: a German string
  // that renames or drops a placeholder renders the literal braces (or
  // nothing) at runtime and no test noticed. Compare the placeholder SETS
  // per key.
  const placeholders = (value: string): string[] =>
    [...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map(m => m[1]).sort();

  it('every key uses the same placeholders in both languages', () => {
    const en = readLocale(enPath);
    const de = readLocale(dePath);
    const mismatched = Object.keys(en)
      .filter(key => key in de)
      .filter(key => placeholders(en[key]).join(',') !== placeholders(de[key]).join(','))
      .map(key => `${key}: en ${placeholders(en[key]).join(',') || '-'} / de ${placeholders(de[key]).join(',') || '-'}`);
    expect(mismatched).toEqual([]);
  });

  it('is a real oracle: a renamed placeholder is reported', () => {
    expect(placeholders('Kick {{name}}?')).toEqual(['name']);
    expect(placeholders('{{name}} wirft {{player}}')).toEqual(['name', 'player']);
    expect(placeholders('no placeholder')).toEqual([]);
  });
});

// Vocabulary policy (Timo, final — 2026-09-03). This is where it lives from
// now on; any future wording change to these three areas should keep it
// consistent with the rules below rather than re-litigating them per-string.
//
// (a) Card names are the game's German proper nouns, used EVERYWHERE —
//     including in English strings: Feuerwerk, Kleeblatt, Kniffel,
//     Plus/Minus, Stop, x2. The old English glosses (Fireworks, Cloverleaf,
//     and "Straight" when it names the Kniffel card) are retired from the
//     ~11 en/translation.json wiki/help strings that used them. A genuine
//     dice-mechanic sentence — describing the actual 1-6 sequence rather
//     than naming the card — may still say "straight" lowercase; those keys
//     are allow-listed explicitly below rather than banned outright.
// (b) Spelling is en-US throughout the EN file: no British -our/-ise/-yse
//     forms (colour, favourite, customise, organise, analyse, centre, grey,
//     …). "hour", "your", "four", "tour" etc. are not British spellings and
//     are not affected.
// (c) The ellipsis is the single character "…" everywhere, in BOTH
//     languages — never the three-character "...".
describe('Card-name vocabulary and spelling policy', () => {
  const en = readLocale(enPath);
  const de = readLocale(dePath);

  it('no EN string uses the retired English card glosses', () => {
    const hits = Object.entries(en)
      .filter(([, value]) => /Fireworks|Cloverleaf/.test(value))
      .map(([key]) => key);
    expect(hits).toEqual([]);
  });

  // Keys where "straight" describes the dice mechanic (a run 1-2-3-4-5-6),
  // not the Kniffel card's name — see policy (a) above.
  const straightMechanicKeys = ['help.cards.kniffelDesc', 'help.cards.kniffelDescClassic'];

  it('no EN string uses "Straight" as the Kniffel gloss', () => {
    const hits = Object.entries(en)
      .filter(([key, value]) => !straightMechanicKeys.includes(key) && /\bStraight\b/.test(value))
      .map(([key]) => key);
    expect(hits).toEqual([]);
  });

  it('the allow-listed dice-mechanic keys still exist and use lowercase "straight"', () => {
    straightMechanicKeys.forEach((key) => {
      expect(en[key]).toMatch(/\bstraight\b/);
    });
  });

  it('no EN string uses a British spelling', () => {
    const britishPattern = /\b(colour|favourite|customise|organise|analyse|centre|grey)\w*\b/i;
    const hits = Object.entries(en)
      .filter(([, value]) => britishPattern.test(value))
      .map(([key]) => key);
    expect(hits).toEqual([]);
  });

  it('no string in either language uses "..." instead of "…"', () => {
    const hitsIn = (locale: Record<string, string>) =>
      Object.entries(locale).filter(([, value]) => value.includes('...')).map(([key]) => key);
    expect(hitsIn(en)).toEqual([]);
    expect(hitsIn(de)).toEqual([]);
  });
});

// C67: every runtime score/count (Scoreboard, Leaderboard, EndScreen,
// Statistics, the dice summary, quick-add chips, the history log) now renders
// through formatInt/formatFixed (src/utils/formatNumber.ts), so a literal
// grouped number baked into a locale string can only be a REGRESSION back to
// "-1000 Pts Eaten"-style hardcoding, or a fresh string that skipped the
// formatter — either way as wrong for a German reader as an English one is
// for the reverse.
//
// The allow-list below is not that: every entry is static rules/help prose
// that quotes a fixed GAME CONSTANT (the winning-score default and range, a
// Tutto's fixed point value) — never a value pulled from live state — and
// each already spells the number in ITS OWN language's grouping (1,000/6,000
// vs. 1.000/6.000). Turning these into interpolated numbers would be a help-
// text rewrite, not a number-formatting fix, and is out of scope here.
describe('No hard-coded grouped numbers outside the help-text allow-list', () => {
  const GROUPED_NUMBER = /\d[,.]\d{3}\b/;

  // Each of these describes a fixed rule constant (the winning-score default/
  // range, or a Tutto's flat point value) in prose, not a rendered game
  // number — see the block comment above.
  const ALLOWED_KEYS = new Set([
    'help.general.intro', // "the target Winning Score (default: 6,000)"
    'help.cards.kniffelDesc', // "awards exactly 2,000 points"
    'help.cards.kniffelDescClassic', // "adds exactly 2,000 points"
    'help.cards.plusMinusDesc', // "exactly 1,000 points" / "loses 1,000 points"
    'help.cards.plusMinusDescClassic', // "+1,000" / "loses 1,000 points"
    'help.settings.winningScore', // "Range: 1,000 to 99,999 (default: 6,000)"
    // Describes the OLD label wording ("-1000 Pts Eaten") this same change
    // renamed to "Hit by -1000" — the label no longer says this, but the
    // wording of help text is reserved for a separate pass (see the PR
    // notes), so the stale reference stays until that pass updates it.
    'help.statistics.s3',
  ]);

  const flaggedIn = (locale: Record<string, string>): string[] =>
    Object.entries(locale)
      .filter(([key, value]) => !ALLOWED_KEYS.has(key) && GROUPED_NUMBER.test(value))
      .map(([key]) => key);

  it('en: no unlisted key contains a hard-coded grouped number', () => {
    const flagged = flaggedIn(readLocale(enPath));
    expect(flagged, `Unexpected hard-coded grouped number(s) in: ${flagged.join(', ')}`).toEqual([]);
  });

  it('de: no unlisted key contains a hard-coded grouped number', () => {
    const flagged = flaggedIn(readLocale(dePath));
    expect(flagged, `Unexpected hard-coded grouped number(s) in: ${flagged.join(', ')}`).toEqual([]);
  });

  // Every allow-listed key must still exist and still actually need the
  // exemption — an entry that no longer matches is stale and should be
  // dropped, or its number should have been formatted instead.
  it('every allow-listed key still exists and still contains a grouped number', () => {
    const en = readLocale(enPath);
    const de = readLocale(dePath);
    ALLOWED_KEYS.forEach((key) => {
      expect(GROUPED_NUMBER.test(en[key] ?? ''), `${key} (en) no longer needs the allow-list entry`).toBe(true);
      expect(GROUPED_NUMBER.test(de[key] ?? ''), `${key} (de) no longer needs the allow-list entry`).toBe(true);
    });
  });

  it('is a real oracle: catches a fresh hard-coded number outside the allow-list', () => {
    expect(GROUPED_NUMBER.test('You scored 6,000 points!')).toBe(true);
    expect(GROUPED_NUMBER.test('Du hast 6.000 Punkte erzielt!')).toBe(true);
    expect(GROUPED_NUMBER.test('You scored {{score}} points!')).toBe(false);
    expect(GROUPED_NUMBER.test('Skipped')).toBe(false);
  });
});
