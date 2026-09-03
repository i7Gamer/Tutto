/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { formatInt, formatFixed, AVG_DECIMALS, _formatterCacheSizeForTests } from './formatNumber';

// This machine's system locale is German — toLocaleString()/Intl with no
// locale argument would silently render "6.000" even for the English UI.
// Every assertion below pins an explicit locale so a regression that drops
// the `lang` argument fails here instead of only showing up on a German OS.
describe('formatInt', () => {
  it('groups thousands with commas in English', () => {
    expect(formatInt(6000, 'en')).toBe('6,000');
  });

  it('groups thousands with periods in German', () => {
    expect(formatInt(6000, 'de')).toBe('6.000');
  });

  it('handles negative numbers', () => {
    expect(formatInt(-1000, 'en')).toBe('-1,000');
    expect(formatInt(-1000, 'de')).toBe('-1.000');
  });

  it('handles zero', () => {
    expect(formatInt(0, 'en')).toBe('0');
    expect(formatInt(0, 'de')).toBe('0');
  });

  it('leaves ungrouped numbers unchanged besides the locale digits', () => {
    expect(formatInt(50, 'en')).toBe('50');
    expect(formatInt(50, 'de')).toBe('50');
  });

  // i18n.ts only ever hands this a supported language, but a stray value
  // (a future language mid-rollout, a bad test double) should degrade to the
  // app's default grouping rather than throwing or reading raw digits.
  it('falls back to English grouping for an unsupported language', () => {
    expect(formatInt(6000, 'fr')).toBe('6,000');
  });

  it('renders a non-finite input as 0 rather than "NaN"', () => {
    expect(formatInt(NaN, 'en')).toBe('0');
    expect(formatInt(Infinity, 'de')).toBe('0');
    expect(formatInt(-Infinity, 'en')).toBe('0');
  });
});

describe('formatFixed', () => {
  it('pads to a fixed number of decimals in English', () => {
    expect(formatFixed(3, 1, 'en')).toBe('3.0');
  });

  it('pads to a fixed number of decimals in German, using a comma', () => {
    expect(formatFixed(3, 1, 'de')).toBe('3,0');
  });

  it('groups the integer part alongside the fixed decimals', () => {
    expect(formatFixed(6000.5, 1, 'en')).toBe('6,000.5');
    expect(formatFixed(6000.5, 1, 'de')).toBe('6.000,5');
  });

  it('handles negative numbers', () => {
    expect(formatFixed(-2.5, 1, 'en')).toBe('-2.5');
  });

  it('handles zero', () => {
    expect(formatFixed(0, 1, 'en')).toBe('0.0');
    expect(formatFixed(0, 1, 'de')).toBe('0,0');
  });

  it('rounds at the requested digit rather than truncating', () => {
    expect(formatFixed(3.456, 1, 'en')).toBe('3.5');
    expect(formatFixed(1.25, 1, 'en')).toBe('1.3');
  });

  it('renders a non-finite input as a zeroed fixed value', () => {
    expect(formatFixed(NaN, 1, 'en')).toBe('0.0');
    expect(formatFixed(Infinity, 1, 'de')).toBe('0,0');
  });
});

describe('formatter caching', () => {
  // A fresh Intl.NumberFormat per call is measurable overhead on a hot path
  // (every score/round render). Both formatInt and formatFixed should build
  // at most one formatter per key across repeated calls, not one per call —
  // asserted via the cache size rather than spying on the native constructor
  // (which vitest cannot reliably intercept as a `new`-target). The size
  // after the FIRST call is the baseline, whatever it is (another test may
  // have already warmed this locale) — what matters is that further calls
  // with the same key don't grow it.
  it('reuses one Intl.NumberFormat across repeated formatInt calls for the same locale', () => {
    formatInt(1, 'en');
    const sizeAfterFirstCall = _formatterCacheSizeForTests().int;
    formatInt(2, 'en');
    formatInt(3, 'en');

    expect(_formatterCacheSizeForTests().int, 'the second and third calls must reuse the cached formatter')
      .toBe(sizeAfterFirstCall);
  });

  it('reuses one Intl.NumberFormat across repeated formatFixed calls for the same locale+digits', () => {
    // Digits unused by any other test in this file, so this cache entry
    // starts absent regardless of test order.
    const UNIQUE_DIGITS = 7;

    formatFixed(1, UNIQUE_DIGITS, 'en');
    const sizeAfterFirstCall = _formatterCacheSizeForTests().fixed;
    formatFixed(2, UNIQUE_DIGITS, 'en');
    formatFixed(3, UNIQUE_DIGITS, 'en');

    expect(_formatterCacheSizeForTests().fixed, 'the second and third calls must reuse the cached formatter')
      .toBe(sizeAfterFirstCall);
  });

  it('keys the formatFixed cache by digits too, not just locale', () => {
    formatFixed(1, 4, 'en');
    const sizeAfterFourDigits = _formatterCacheSizeForTests().fixed;
    formatFixed(1, 5, 'en');

    expect(_formatterCacheSizeForTests().fixed, 'a different digit count is a different formatter')
      .toBe(sizeAfterFourDigits + 1);
  });
});

// Named so every average on screen renders to the same precision by
// construction, instead of each call site spelling out its own "1" that
// could drift from its neighbour's.
describe('AVG_DECIMALS', () => {
  it('is 1 decimal place', () => {
    expect(AVG_DECIMALS).toBe(1);
  });
});
