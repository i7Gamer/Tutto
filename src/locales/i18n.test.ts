/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const srcDir = path.join(process.cwd(), 'src');
const localesDir = path.join(srcDir, 'locales');

const getJsonKeys = (obj, prefix = '') => {
  let keys = [];
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      keys = keys.concat(getJsonKeys(obj[key], `${prefix}${key}.`));
    } else {
      keys.push(`${prefix}${key}`);
    }
  }
  return keys;
};

describe('i18n Translations completeness', () => {
  const enTranslations = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'translation.json'), 'utf8'));
  const deTranslations = JSON.parse(fs.readFileSync(path.join(localesDir, 'de', 'translation.json'), 'utf8'));

  const enKeys = getJsonKeys(enTranslations).sort();
  const deKeys = getJsonKeys(deTranslations).sort();

  it('verifies that English and German translation files have the exact same keys', () => {
    // Find keys in English but missing in German
    const missingInDe = enKeys.filter(key => !deKeys.includes(key));
    // Find keys in German but missing in English
    const missingInEn = deKeys.filter(key => !enKeys.includes(key));

    expect(missingInDe, `Keys missing in German translation: ${missingInDe.join(', ')}`).toEqual([]);
    expect(missingInEn, `Keys missing in English translation: ${missingInEn.join(', ')}`).toEqual([]);
  });

  // Deliberately NOT repeated here: "every t('...') key exists in the locale
  // files". That check lives in translations.test.ts, which scans .ts/.tsx and
  // verifies BOTH locales. The version that used to sit here filtered for
  // .js/.jsx in a TypeScript project, so it saw exactly two files (src/sw.js,
  // which contains no t(), and src/sw.test.js, which it skipped): usedKeys was
  // always empty and the assertion was `expect([]).toEqual([])`. Proved by
  // mutation — adding a t('totally.missing.key') to a component leaves this
  // file green and fails translations.test.ts.
});
