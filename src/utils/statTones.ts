// The colour recipes the statistics tiles are painted with. Each tone names
// the value's text colour and the tile's surface (background plus border) —
// the two always travelled together and were written out at every tile, 31
// times over ten colours.
//
// Spelled out rather than built from a hue name: Tailwind generates classes
// by scanning the source for literal strings, so a `text-${hue}-600` would
// simply never exist.
export const STAT_TONES = {
  indigo: {
    text: 'text-indigo-600 dark:text-indigo-400',
    surface: 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30',
  },
  emerald: {
    text: 'text-emerald-500 dark:text-emerald-400',
    surface: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-500/30',
  },
  amber: {
    text: 'text-amber-600 dark:text-amber-400',
    surface: 'bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-500/30',
  },
  // A win streak long enough to be worth showing off: the same amber, turned up.
  amberHot: {
    text: 'text-amber-600 dark:text-amber-400 font-extrabold',
    surface: 'bg-amber-100/70 dark:bg-amber-900/40 border-amber-200 dark:border-amber-500/50 shadow-xs animate-pulse',
  },
  red: {
    text: 'text-red-600 dark:text-red-400',
    surface: 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30',
  },
  yellow: {
    text: 'text-yellow-600 dark:text-yellow-400',
    surface: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-500/30',
  },
  green: {
    text: 'text-green-600 dark:text-green-400',
    surface: 'bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-500/30',
  },
  sky: {
    text: 'text-sky-600 dark:text-sky-400',
    surface: 'bg-sky-50 dark:bg-sky-900/20 border-sky-100 dark:border-sky-500/30',
  },
  purple: {
    text: 'text-purple-600 dark:text-purple-400',
    surface: 'bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-500/30',
  },
  orange: {
    text: 'text-orange-600 dark:text-orange-400',
    surface: 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-500/30',
  },
  pink: {
    text: 'text-pink-600 dark:text-pink-400',
    surface: 'bg-pink-50 dark:bg-pink-900/20 border-pink-100 dark:border-pink-500/30',
  },
  // For counts that are neither good nor bad — playtime, turns played.
  neutral: {
    text: 'text-gray-700 dark:text-gray-200',
    surface: 'bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600',
  },
} as const;

export type StatTone = keyof typeof STAT_TONES;

// What a tile is painted in unless it asks for something else.
export const DEFAULT_STAT_TONE: StatTone = 'indigo';
