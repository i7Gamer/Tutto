import { useCallback, useState, useSyncExternalStore } from 'react';
import { localStore } from '../utils/storage';
import {
  installPromptState, isIosSafari, isStandalone,
  HAS_FINISHED_GAME_KEY, INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE,
  type InstallPromptState,
} from '../utils/installPrompt';

const BEFORE_INSTALL_PROMPT_EVENT = 'beforeinstallprompt';

/**
 * The `beforeinstallprompt` event's own shape. Chromium-only and not part of
 * any spec, so it isn't in lib.dom.d.ts — declared locally rather than in
 * vite-env.d.ts because nothing outside this hook needs to name it.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallPromptSubscriber = () => void;

// Browser install events can fire while Home is unmounted for a game or the
// statistics page. The event belongs to the page, not one hook instance, so
// retain it here and let mounted hooks subscribe to changes.
let deferredInstallEvent: BeforeInstallPromptEvent | null = null;
const installPromptSubscribers = new Set<InstallPromptSubscriber>();

const notifyInstallPromptSubscribers = (): void => {
  installPromptSubscribers.forEach(notify => notify());
};

const subscribeToInstallPrompt = (notify: InstallPromptSubscriber): (() => void) => {
  installPromptSubscribers.add(notify);
  return () => {
    installPromptSubscribers.delete(notify);
  };
};

const getDeferredInstallEvent = (): BeforeInstallPromptEvent | null => deferredInstallEvent;

const setDeferredInstallEvent = (event: BeforeInstallPromptEvent | null): void => {
  deferredInstallEvent = event;
  notifyInstallPromptSubscribers();
};

const handleBeforeInstallPrompt = (event: Event): void => {
  // preventDefault stops Chrome from also showing its own mini-infobar —
  // without it the browser's prompt and this card's would compete.
  event.preventDefault();
  setDeferredInstallEvent(event as BeforeInstallPromptEvent);
};

// One page-lifetime listener keeps the deferred event through route changes.
if (typeof window !== 'undefined') {
  window.addEventListener(BEFORE_INSTALL_PROMPT_EVENT, handleBeforeInstallPrompt);
}

/** Test-only reset for the module-level browser-event holder. */
export const _resetInstallPromptForTests = (): void => {
  setDeferredInstallEvent(null);
};

export interface UseInstallPromptResult {
  state: InstallPromptState;
  /** Shows the browser's own install dialog. No-op with no event held (e.g. the iOS variant). */
  install: () => Promise<void>;
  /** Permanent: writes the "never show this again" flag. */
  dismiss: () => void;
}

/**
 * Listens for Chromium's `beforeinstallprompt`, holds it until the player
 * acts, and exposes the (state, install, dismiss) trio InstallPrompt.tsx
 * renders from. See installPrompt.ts for the pure state machine this wires up.
 */
export function useInstallPrompt(): UseInstallPromptResult {
  // React verifies this snapshot again when it subscribes, so an install event
  // received after render but before the subscription is established is not
  // missed.
  const deferredEvent = useSyncExternalStore(
    subscribeToInstallPrompt,
    getDeferredInstallEvent,
    getDeferredInstallEvent,
  );
  // Read once per mount — install()/dismiss() are the only things that
  // change either flag for the life of this hook instance, and both go
  // through setState below rather than a re-read.
  const [dismissed, setDismissed] = useState(
    () => localStore.read(INSTALL_PROMPT_DISMISSED_KEY) === INSTALL_PROMPT_FLAG_VALUE,
  );
  const [hasFinishedGame] = useState(
    () => localStore.read(HAS_FINISHED_GAME_KEY) === INSTALL_PROMPT_FLAG_VALUE,
  );

  const install = useCallback(async () => {
    const event = deferredInstallEvent;
    if (!event) return;
    // Browser deferred events are single-use. Clear synchronously, before the
    // await, so two rapid presses cannot call prompt() twice.
    setDeferredInstallEvent(null);
    await event.prompt();
    const { outcome } = await event.userChoice;
    // The event is single-use regardless of outcome (Chrome invalidates it
    // once prompt() resolves) — clearing it drops `hasEvent` back to false,
    // which alone hides the card for the rest of this session even on a
    // "dismissed" outcome, with nothing written to storage.
    if (outcome === 'accepted') {
      localStore.write(INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE);
      setDismissed(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    setDeferredInstallEvent(null);
    localStore.write(INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE);
    setDismissed(true);
  }, []);

  const state = installPromptState({
    hasEvent: deferredEvent !== null,
    dismissed,
    hasFinishedGame,
    standalone: isStandalone(window),
    iosSafari: isIosSafari(navigator),
  });

  return { state, install, dismiss };
}
