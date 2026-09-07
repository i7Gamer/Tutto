// Announces a landed roll's values as a real list ("1, 2, and 3") rather than
// a bare join — Intl.ListFormat is available from Safari 14.1+, inside the
// repo's 16.4 floor, but the constructor is feature-detected rather than
// assumed: an engine that lacks it falls back to a plain comma join instead
// of throwing mid-announcement.
const FALLBACK_SEPARATOR = ', ';

export const formatList = (values: number[], locale: string): string => {
  const strings = values.map(String);
  if (typeof Intl !== 'undefined' && typeof Intl.ListFormat === 'function') {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(strings);
  }
  return strings.join(FALLBACK_SEPARATOR);
};
