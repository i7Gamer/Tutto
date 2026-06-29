import React from 'react';

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

    const lastCrash = localStorage.getItem('last_crash_time');
    const now = Date.now();

    if (!lastCrash || now - parseInt(lastCrash, 10) > 10000) {
      localStorage.setItem('last_crash_time', now.toString());
      this.clearCacheAndReload();
    }
  }

  clearCacheAndReload() {
    localStorage.removeItem('tutto_dice_turn_state');
    localStorage.removeItem('tutto_local_game');
    localStorage.removeItem('last_crash_time');
    sessionStorage.removeItem('tutto_online_session');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations.forEach(r => r.unregister());
        window.location.reload();
      }).catch(() => window.location.reload());
    } else {
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#f4f7f6', color: '#1a1a1a' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem', color: '#dc2626' }}>Oops! Something went wrong.</h2>
          <p style={{ marginBottom: '2rem' }}>The application encountered an unexpected error and needs to reload.</p>
          <button
            onClick={() => { localStorage.removeItem('last_crash_time'); this.clearCacheAndReload(); }}
            style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', background: '#4f46e5', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
          >
            Clear Cache & Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
