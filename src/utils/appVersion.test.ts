/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { APP_VERSION } from './appVersion';

describe('APP_VERSION', () => {
  it('is the version the bundle was built from', () => {
    // Substituted at build time from package.json rather than imported, so the
    // manifest does not end up in the bundle. That substitution is the part
    // that can silently break — a missing define would leave the string
    // undefined and the Help footer would advertise the wrong build.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { version: string };

    expect(APP_VERSION).toBe(manifest.version);
  });

  it('is a version string, not a placeholder', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
