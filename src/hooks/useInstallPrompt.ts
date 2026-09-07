import { useCallback, useEffect, useState } from 'react';
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
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  // Read once per mount — install()/dismiss() are the only things that
  // change either flag for the life of this hook instance, and both go
  // through setState below rather than a re-read.
  const [dismissed, setDismissed] = useState(
    () => localStore.read(INSTALL_PROMPT_DISMISSED_KEY) === INSTALL_PROMPT_FLAG_VALUE,
  );
  const [hasFinishedGame] = useState(
    () => localStore.read(HAS_FINISHED_GAME_KEY) === INSTALL_PROMPT_FLAG_VALUE,
  );

  useEffect(() => {
    // preventDefault stops Chrome from also showing its own mini-infobar —
    // without it the browser's prompt and this card's would compete.
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener(BEFORE_INSTALL_PROMPT_EVENT, handleBeforeInstallPrompt);
    return () => window.removeEventListener(BEFORE_INSTALL_PROMPT_EVENT, handleBeforeInstallPrompt);
  }, []);

  const install = useCallback(async () => {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    const { outcome } = await deferredEvent.userChoice;
    // The event is single-use regardless of outcome (Chrome invalidates it
    // once prompt() resolves) — clearing it drops `hasEvent` back to false,
    // which alone hides the card for the rest of this session even on a
    // "dismissed" outcome, with nothing written to storage.
    setDeferredEvent(null);
    if (outcome === 'accepted') {
      localStore.write(INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE);
      setDismissed(true);
    }
  }, [deferredEvent]);

  const dismiss = useCallback(() => {
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
