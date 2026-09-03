// This machine's (and plenty of players') OS locale is not English, so
// Number.prototype.toLocaleString() with no locale argument renders "6.000"
// for the English UI too — the number silently follows the system, not the
// language the player picked in LanguageSwitcher. Every render of a
// user-facing count or score must go through one of these two, passing the
// i18next language (`i18n.language` / `useTranslation().i18n.language`)
// explicitly, rather than calling toLocaleString()/Intl directly.

// i18next language code -> the regional tag whose grouping the app wants.
// One entry per resource in i18n.ts's `resources` map; a language added
// there without an entry here falls through to DEFAULT_LOCALE_TAG below.
const LOCALE_TAGS: Record<string, string> = {
  en: 'en-US',
  de: 'de-DE',
};

// i18n.ts's own fallbackLng is 'en' — an unrecognised language code (a stray
// test double, a future language mid-rollout) gets the same fallback here.
const DEFAULT_LOCALE_TAG = LOCALE_TAGS.en;

const localeTagFor = (lang: string): string => LOCALE_TAGS[lang] ?? DEFAULT_LOCALE_TAG;

// Non-finite input renders as this rather than "NaN"/"Infinity" — the same
// reasoning as formatTime's zero clock: nothing in the store should produce
// one today, but a rendered NaN is worse than a rendered zero.
const NON_FINITE_FALLBACK = 0;

// Building an Intl.NumberFormat is not free, and every score/round render
// goes through one of these two — so each is memoised per key rather than
// rebuilt on every call. Keyed by the resolved locale tag (not the raw
// `lang`), since that's what actually determines the formatter's behaviour.
const intFormatters = new Map<string, Intl.NumberFormat>();

const intFormatterFor = (lang: string): Intl.NumberFormat => {
  const tag = localeTagFor(lang);
  let formatter = intFormatters.get(tag);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tag);
    intFormatters.set(tag, formatter);
  }
  return formatter;
};

/** A locale-grouped whole number: 6000 -> "6,000" (en) / "6.000" (de). */
export const formatInt = (n: number, lang: string): string =>
  intFormatterFor(lang).format(Number.isFinite(n) ? n : NON_FINITE_FALLBACK);

// Every average on screen renders to the same precision by construction,
// rather than each call site spelling out its own "1" that could drift from
// its neighbour's (EndScreen's Avg Busts/Game and Statistics's two
// Math.round-based averages used to disagree on this before both moved here).
export const AVG_DECIMALS = 1;

// A second cache, keyed by locale tag AND digits: unlike formatInt, digits
// varies per call site (AVG_DECIMALS today, but not by contract), so the two
// together are what determines the formatter.
const fixedFormatters = new Map<string, Intl.NumberFormat>();

const fixedFormatterFor = (digits: number, lang: string): Intl.NumberFormat => {
  const key = `${localeTagFor(lang)}:${digits}`;
  let formatter = fixedFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(localeTagFor(lang), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    fixedFormatters.set(key, formatter);
  }
  return formatter;
};

/** A locale-grouped number fixed to `digits` decimal places: (6000.5, 1) -> "6,000.5" (en) / "6.000,5" (de). */
export const formatFixed = (n: number, digits: number, lang: string): string =>
  fixedFormatterFor(digits, lang).format(Number.isFinite(n) ? n : NON_FINITE_FALLBACK);

/** Test-only: the number of distinct formatters each cache currently holds —
 *  lets a test assert that repeated calls for the same key reuse one
 *  formatter instead of building a fresh Intl.NumberFormat every time. */
export const _formatterCacheSizeForTests = (): { int: number; fixed: number } => ({
  int: intFormatters.size,
  fixed: fixedFormatters.size,
});
