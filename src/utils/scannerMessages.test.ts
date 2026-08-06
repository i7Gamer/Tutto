/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SCANNER_MESSAGE_KEYS, STATUS_MESSAGES } from './scannerMessages';

const readLocale = (locale: string): Record<string, string> =>
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'locales', locale, 'translation.json'), 'utf8')
  ) as Record<string, string>;

describe('scanner messages', () => {
  it('covers every state the camera can report', () => {
    // A status with no entry renders no explanation at all, which is the one
    // outcome this table exists to prevent.
    const silent = Object.entries(STATUS_MESSAGES)
      .filter(([status, message]) => status !== 'idle' && message === null)
      .map(([status]) => status);

    expect(silent).toEqual([]);
  });

  it.each(['en', 'de'])('is fully translated into %s', locale => {
    // locales/translations.test.ts finds keys by scanning for translation calls
    // written out in full, and these are looked up from a table instead — so
    // nothing else checks them.
    const translations = readLocale(locale);

    expect(SCANNER_MESSAGE_KEYS.length).toBeGreaterThan(0);
    expect(SCANNER_MESSAGE_KEYS.filter(key => !(key in translations))).toEqual([]);
  });
});
