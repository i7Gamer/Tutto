import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatList } from './formatList';

describe('formatList', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Locale pinned explicitly (this machine's OS locale is German) — a call
  // that relied on a default would pass in this environment for the wrong
  // reason and fail on an English-locale machine.
  it('renders a two-value list in English', () => {
    expect(formatList([1, 2], 'en')).toBe('1 and 2');
  });

  it('renders a three-value list in English with the Oxford comma', () => {
    expect(formatList([1, 2, 3], 'en')).toBe('1, 2, and 3');
  });

  it('renders a single value with no separator in English', () => {
    expect(formatList([4], 'en')).toBe('4');
  });

  it('renders a two-value list in German', () => {
    expect(formatList([1, 2], 'de')).toBe('1 und 2');
  });

  it('renders a three-value list in German', () => {
    expect(formatList([1, 2, 3], 'de')).toBe('1, 2 und 3');
  });

  it('renders an empty list as an empty string', () => {
    expect(formatList([], 'en')).toBe('');
  });

  // Safari 14.1+ (inside the repo's 16.4 floor) has Intl.ListFormat, but the
  // constructor is feature-detected rather than assumed — this proves the
  // fallback path independently of any real engine's support.
  it('falls back to a comma-joined string when Intl.ListFormat is unavailable', () => {
    vi.stubGlobal('Intl', { ...Intl, ListFormat: undefined });
    expect(formatList([1, 2, 3], 'en')).toBe('1, 2, 3');
  });
});
