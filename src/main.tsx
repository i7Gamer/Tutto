import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerSW } from 'virtual:pwa-register';
import { useGameStore } from './store/useGameStore';
import { applyUpdateWhenIdle, reloadOnceForUpdate } from './utils/swUpdate';

// The worker installs and then WAITS (src/sw.js has no unconditional
// skipWaiting any more), so a new build never takes over at a moment nobody
// chose. swUpdate.ts hands it the go-ahead at the first point a reload
// interrupts nothing, and if that point never comes the browser activates it
// on the next cold start with no client to reload — which is exactly what the
// old "will update on next launch" comment here claimed, and never did.
const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    applyUpdateWhenIdle({
      apply: () => { void updateServiceWorker(); },
      getState: useGameStore.getState,
      // A plain listener, not a selector subscription: the predicate reads
      // four fields and this fires at most once, so there is nothing to gain
      // from narrowing it and a stale field to lose.
      subscribe: (listener) => useGameStore.subscribe(listener),
    });
  },
  // Replaces the register template's own unguarded window.location.reload(),
  // which it wires up afresh every time a worker enters `waiting`.
  onNeedReload() {
    reloadOnceForUpdate();
  },
  onOfflineReady() {
    console.log('App is ready to work offline');
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
