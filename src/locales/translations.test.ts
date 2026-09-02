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
