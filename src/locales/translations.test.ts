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
  // A thirteenth refusal added server-side would still ship untranslated (the
  // lobby falls back to the server's English sentence for a code it does not
  // know), and nothing would say so — hence the equality against the server's
  // own list rather than a subset check in either direction. Sorted copies: the
  // map is ordered by the handler's checks, and that order is not the contract.
  it('maps exactly the refusal codes the server can send', () => {
    expect([...JOIN_ERROR_KEYS.keys()].sort()).toEqual([...JOIN_REFUSAL_CODES].sort());
  });
});
