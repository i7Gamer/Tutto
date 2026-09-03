import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerSW } from 'virtual:pwa-register';
import { useGameStore } from './store/useGameStore';
import { applyUpdateWhenIdle, reloadOnceForUpdate, type UpdateIdleState } from './utils/swUpdate';
import { uiBusyState } from './utils/uiBusyState';

// isSafeToApplyUpdate's fields come from two independent sources: the four
// game-state ones live in useGameStore, and hasFormDraft/statsScreenOpen have
// no home there (see uiBusyState.ts) — they are component state OnlineLobby
// and App.tsx report directly. Both onNeedRefresh and onNeedReload below need
// the same composed view, so it is built once here.
const getIdleState = (): UpdateIdleState => ({
  players: useGameStore.getState().players,
  currentPlayerIndex: useGameStore.getState().currentPlayerIndex,
  finished: useGameStore.getState().finished,
  roomId: useGameStore.getState().roomId,
  hasFormDraft: uiBusyState.getState().hasFormDraft,
  statsScreenOpen: uiBusyState.getState().statsScreenOpen,
});

// A plain listener on both sources, not a selector subscription: the
// predicate reads six fields total across the two stores and each watch
// fires at most once, so there is nothing to gain from narrowing either and a
// stale field to lose.
const subscribeIdleState = (listener: () => void): (() => void) => {
  const unsubscribeStore = useGameStore.subscribe(listener);
  const unsubscribeUi = uiBusyState.subscribe(listener);
  return () => {
    unsubscribeStore();
    unsubscribeUi();
  };
};

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
      getState: getIdleState,
      subscribe: subscribeIdleState,
    });
  },
  // Replaces the register template's own unguarded window.location.reload(),
  // which it wires up afresh every time a worker enters `waiting`. Fires in
  // EVERY tab whose controller changes — including one claimed by another
  // tab's update, which never called apply() itself — so this needs the same
  // idle gate applyUpdateWhenIdle uses above, not just a flag saying whether
  // this tab was the one that asked.
  onNeedReload() {
    reloadOnceForUpdate({
      getState: getIdleState,
      subscribe: subscribeIdleState,
    });
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
