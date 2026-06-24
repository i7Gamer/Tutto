import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'
import { registerSW } from 'virtual:pwa-register'

// Auto-update Service Worker
registerSW({
  immediate: true,
  onNeedRefresh() {
    // A new service worker is available.
    // We intentionally don't force a reload to prevent interrupting active games.
    console.log('New update available. The app will update on next launch.');
  },
  onOfflineReady() {
    console.log('App is ready to work offline');
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
