import { localStore, sessionStore } from '../utils/storage';
import React from 'react';
import { recordCrash } from '../utils/crashLog';
import { clearTurnCaches } from '../utils/diceTurnState';
import { CRASH_LOOP_WINDOW_MS } from '../utils/uiTimings';
import ConfirmModal from './ConfirmModal';
// Class components can't use the useTranslation hook — the i18next instance
// itself is directly importable and usable outside of React's render cycle.
import i18n from '../i18n';

interface ErrorBoundaryState {
  hasError: boolean;
  // Drives the confirm dialog for the destructive "Reset app data" button.
  // ConfirmModal itself is a plain function component (it only needs the
  // global i18next instance via useTranslation, not a Provider this class
  // component sits above), so it can be rendered directly from here instead
  // of falling back to window.confirm.
  showResetConfirm: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

/**
 * Clears Cache Storage and unregisters every service worker registration,
 * awaiting both before resolving. Shared by softRecover and hardReset so
 * reload only ever happens once that work has actually finished — otherwise
 * a still-registered worker can re-serve the crashing bundle right after the
 * "recovery" reload.
 *
 * `typeof caches` rather than a bare reference: the app is explicitly
 * playable over plain http:// on a LAN, where Cache Storage is undefined and
 * touching it would throw before the unregister ever ran.
 */
const clearCachesAndUnregisterWorkers = (): Promise<void> => {
  const unregisterAll = (): Promise<void> => {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.getRegistrations()
      .then(registrations => Promise.all(registrations.map(r => r.unregister())))
      .then(() => undefined)
      .catch(() => undefined);
  };

  if (typeof caches === 'undefined') {
    return unregisterAll();
  }
  return caches.keys()
    .then(names => Promise.all(names.map(name => caches.delete(name))))
    .catch(() => {})
    .then(unregisterAll);
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, showResetConfirm: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true, showResetConfirm: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
    // Persist + report the crash BEFORE the auto-reload below wipes all traces.
    recordCrash(error, errorInfo.componentStack);

    const lastCrash = localStore.read('last_crash_time');
    const now = Date.now();

    if (!lastCrash || now - parseInt(lastCrash, 10) > CRASH_LOOP_WINDOW_MS) {
      // Only auto-reload if the attempt could actually be recorded. Where
      // storage is unavailable (site data blocked, a third-party context) the
      // throttle never persists, so every crash would look like the first one
      // and reload again — the forever-loop the comment below describes, with
      // no fallback UI to land on. Without a throttle, the manual buttons
      // below are the honest offer.
      if (localStore.write('last_crash_time', now.toString())) {
        void this.softRecover();
      }
    }
  }

  /**
   * The automatic first-crash path, and the manual "Clear Cache & Reload"
   * button: clears caches and service workers, but deliberately leaves
   * tutto_local_game and tutto_online_session alone. A failed lazy route
   * chunk after a deploy routes through this boundary via React with no
   * action from the player — wiping their in-progress game on that alone
   * would be a bug, not a recovery.
   */
  softRecover = (): Promise<void> => {
    clearTurnCaches();
    return clearCachesAndUnregisterWorkers().then(() => {
      window.location.reload();
    });
  };

  /**
   * Today's original destructive behaviour, kept for when soft recovery
   * genuinely isn't enough (e.g. a corrupted local game is itself what's
   * crashing the app). Only reachable from the explicit "Reset app data"
   * button below, behind a confirmation naming what will be lost.
   */
  hardReset = (): Promise<void> => {
    clearTurnCaches();
    localStore.remove('tutto_local_game');
    sessionStore.remove('tutto_online_session');
    return clearCachesAndUnregisterWorkers().then(() => {
      window.location.reload();
    });
  };

  // Arrow-function class fields so `this` stays bound to the instance
  // regardless of how the method is later invoked (e.g. passed directly as
  // an event handler rather than through an arrow-wrapped call site).
  handleClearCacheClick = () => {
    // Reset here, not inside softRecover/hardReset: componentDidCatch's own
    // write is what the auto-reload throttle depends on, and clearing it
    // there would auto-reload forever on a persistent crash. Only an explicit
    // click — the player asking to retry — resets it.
    localStore.remove('last_crash_time');
    void this.softRecover();
  };

  handleResetAppDataClick = () => {
    this.setState({ showResetConfirm: true });
  };

  handleResetCancel = () => {
    this.setState({ showResetConfirm: false });
  };

  handleResetConfirm = () => {
    this.setState({ showResetConfirm: false });
    localStore.remove('last_crash_time');
    void this.hardReset();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#f4f7f6', color: '#1a1a1a' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem', color: '#dc2626' }}>{i18n.t('errorBoundary.title', 'Oops! Something went wrong.')}</h2>
          <p style={{ marginBottom: '2rem' }}>{i18n.t('errorBoundary.description', 'The application encountered an unexpected error and needs to reload.')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', justifyContent: 'center' }}>
            <button
              onClick={this.handleClearCacheClick}
              style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', background: '#4f46e5', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
            >
              {i18n.t('home.clearCache', 'Clear Cache & Reload')}
            </button>
            <button
              onClick={this.handleResetAppDataClick}
              style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', background: 'transparent', color: '#dc2626', border: '1px solid #dc2626', borderRadius: '8px', fontWeight: 'bold' }}
            >
              {i18n.t('errorBoundary.resetAppData', 'Reset app data')}
            </button>
          </div>
          <ConfirmModal
            open={this.state.showResetConfirm}
            danger
            message={i18n.t('error.hardResetConfirm', 'This also deletes the saved local game and the online session on this device. Continue?')}
            onCancel={this.handleResetCancel}
            onConfirm={this.handleResetConfirm}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
