/**
 * Pure decision logic for the "Add to Home Screen" card on Home.tsx (see
 * src/components/InstallPrompt.tsx and src/hooks/useInstallPrompt.ts for the
 * two things that turn this into what's actually on screen).
 *
 * `isIosSafari` is the repo's first user-agent sniff. Every other
 * capability check in the app (iosSwitchHaptic.ts, shareSupport.ts) is a
 * feature detection instead, and that is deliberate — a feature test answers
 * "can I do the thing", which is what those call sites need. There is no
 * feature that answers "can this browser add the current page to the home
 * screen": `beforeinstallprompt` never fires on Safari at all (Chromium-only),
 * and nothing else on `navigator` or `window` distinguishes Mobile Safari
 * from a UIWebView-based browser wearing its UA string (Chrome and Firefox on
 * iOS both do, via CriOS/FxiOS). Sniffing the UA is the only way to reach "so
 * tell them how, instead" for that one browser.
 */

// Both flags below are per-device localStorage, read straight from
// localStore by whichever component needs them (EndScreen.tsx,
// useInstallPrompt.ts, InstallPrompt.tsx) — never through the zustand store
// and never listed in a sync/persistence key list, the same way
// recentRooms.ts keeps its own key. Neither is a counter: the value written
// is always this one string, checked with `=== INSTALL_PROMPT_FLAG_VALUE`.
export const HAS_FINISHED_GAME_KEY = 'tutto_hasFinishedGame';
export const INSTALL_PROMPT_DISMISSED_KEY = 'tutto_installPromptDismissed';
export const INSTALL_PROMPT_FLAG_VALUE = 'true';

/** The narrow shape of `window` this needs — a fake for it is one line, not a whole global stub. */
export interface StandaloneWindow {
  matchMedia: (query: string) => { matches: boolean };
  navigator: { standalone?: boolean };
}

const DISPLAY_MODE_STANDALONE_QUERY = '(display-mode: standalone)';

/** True once the app is already running from its installed/home-screen icon. */
export const isStandalone = (win: StandaloneWindow): boolean =>
  win.matchMedia(DISPLAY_MODE_STANDALONE_QUERY).matches || win.navigator.standalone === true;

/** The narrow shape of `navigator` this needs. */
export interface UserAgentNavigator {
  userAgent: string;
}

const IOS_DEVICE_UA_PATTERN = /iPhone|iPad|iPod/;
// Both are WebKit under the hood (Apple requires it on iOS), but neither is
// the actual Safari chrome — the "Share" sheet the instructions below send a
// player to belongs to Safari specifically, not to whatever wraps CriOS/FxiOS.
const CHROME_IOS_UA_PATTERN = /CriOS/;
const FIREFOX_IOS_UA_PATTERN = /FxiOS/;

/**
 * True for Mobile Safari on iPhone/iPad/iPod. False for every other browser,
 * including Chrome/Firefox on iOS and an iPad requesting the desktop site
 * (whose UA carries no iPhone/iPad/iPod token at all — it reads as a Mac, and
 * falls through to `installPromptState`'s "hidden" branch, which is the
 * correct outcome there: an iPad in desktop mode doesn't offer the same
 * Share → Add to Home Screen path a mobile-UA visit does).
 */
export const isIosSafari = (navigator: UserAgentNavigator): boolean => {
  const ua = navigator.userAgent;
  if (!IOS_DEVICE_UA_PATTERN.test(ua)) return false;
  if (CHROME_IOS_UA_PATTERN.test(ua)) return false;
  if (FIREFOX_IOS_UA_PATTERN.test(ua)) return false;
  return true;
};

export type InstallPromptState = 'hidden' | 'native' | 'ios';

export interface InstallPromptStateInput {
  /** A `beforeinstallprompt` event is being held, ready for `prompt()`. */
  hasEvent: boolean;
  /** The player has permanently dismissed the card on this device. */
  dismissed: boolean;
  /** This device has reached an end screen at least once (see EndScreen.tsx). */
  hasFinishedGame: boolean;
  /** The app is already running installed/standalone. */
  standalone: boolean;
  /** The browser is Mobile Safari on iOS, which never fires `beforeinstallprompt`. */
  iosSafari: boolean;
}

/**
 * Which variant of the install card to show, if any.
 *
 * `standalone` is checked first and alone decides "hidden": an installed app
 * asking to be installed again would be a bug, not a corner case, regardless
 * of what else is true.
 */
export const installPromptState = ({
  hasEvent, dismissed, hasFinishedGame, standalone, iosSafari,
}: InstallPromptStateInput): InstallPromptState => {
  if (standalone) return 'hidden';
  if (dismissed || !hasFinishedGame) return 'hidden';
  if (hasEvent) return 'native';
  if (iosSafari) return 'ios';
  return 'hidden';
};
