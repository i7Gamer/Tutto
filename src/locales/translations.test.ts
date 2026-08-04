/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

    const enPath = path.resolve(__dirname, './en/translation.json');
    const dePath = path.resolve(__dirname, './de/translation.json');

    const enKeys = Object.keys(JSON.parse(fs.readFileSync(enPath, 'utf8')));
    const deKeys = Object.keys(JSON.parse(fs.readFileSync(dePath, 'utf8')));

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
