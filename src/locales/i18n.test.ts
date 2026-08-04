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

const getAllSourceFiles = (dirPath, arrayOfFiles = []) => {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
      arrayOfFiles = getAllSourceFiles(path.join(dirPath, file), arrayOfFiles);
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
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

  it('verifies that all translation keys used in source code exist in the translation files', () => {
    const allFiles = getAllSourceFiles(srcDir);
    const translationKeyRegex = /(?:^|[^a-zA-Z0-9_])t\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g;
    
    const usedKeys = new Set();

    allFiles.forEach(file => {
      // Skip test files
      if (file.endsWith('.test.js') || file.endsWith('.test.jsx')) return;
      
      const content = fs.readFileSync(file, 'utf8');
      let match;
      while ((match = translationKeyRegex.exec(content)) !== null) {
        usedKeys.add(match[1]);
      }
    });

    const usedKeysArray = Array.from(usedKeys);
    const missingKeys = usedKeysArray.filter(key => !enKeys.includes(key));

    expect(missingKeys, `Found translation keys in source code that are missing from translation.json: ${missingKeys.join(', ')}`).toEqual([]);
  });
});
