import { localStore, sessionStore } from '../utils/storage';
import React from 'react';
import { recordCrash } from '../utils/crashLog';
import { clearTurnCaches } from '../utils/diceTurnState';
// Class components can't use the useTranslation hook — the i18next instance
// itself is directly importable and usable outside of React's render cycle.
import i18n from '../i18n';

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
    // Persist + report the crash BEFORE the auto-reload below wipes all traces.
    recordCrash(error, errorInfo.componentStack);

    const lastCrash = localStore.read('last_crash_time');
    const now = Date.now();

    if (!lastCrash || now - parseInt(lastCrash, 10) > 10000) {
      // Only auto-reload if the attempt could actually be recorded. Where
      // storage is unavailable (site data blocked, a third-party context) the
      // throttle never persists, so every crash would look like the first one
      // and reload again — the forever-loop the comment below describes, with
      // no fallback UI to land on. Without a throttle, the manual "Clear Cache
      // & Reload" button is the honest offer.
      if (localStore.write('last_crash_time', now.toString())) {
        this.clearCacheAndReload();
      }
    }
  }

  // Arrow-function class field so `this` stays bound to the instance
  // regardless of how the method is later invoked (e.g. passed directly as
  // an event handler rather than through an arrow-wrapped call site).
  clearCacheAndReload = () => {
    // last_crash_time is deliberately left alone here — componentDidCatch just set
    // it to throttle auto-reloads. Clearing it here meant a persistent render crash
    // found no last_crash_time on every reload and auto-reloaded forever, never
    // reaching the fallback UI below. Only the manual "Clear Cache & Reload" button
    // resets it, since that's an explicit user request to retry.
    clearTurnCaches();
    localStore.remove('tutto_local_game');
    sessionStore.remove('tutto_online_session');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations.forEach(r => r.unregister());
        window.location.reload();
      }).catch(() => window.location.reload());
    } else {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#f4f7f6', color: '#1a1a1a' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem', color: '#dc2626' }}>{i18n.t('errorBoundary.title', 'Oops! Something went wrong.')}</h2>
          <p style={{ marginBottom: '2rem' }}>{i18n.t('errorBoundary.description', 'The application encountered an unexpected error and needs to reload.')}</p>
          <button
            onClick={() => { localStore.remove('last_crash_time'); this.clearCacheAndReload(); }}
            style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', background: '#4f46e5', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
          >
            {i18n.t('home.clearCache', 'Clear Cache & Reload')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
