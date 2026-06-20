import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

// Auto-update Service Worker
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // With autoUpdate and skipWaiting, the SW activates immediately.
    // We can force a reload here to ensure the user gets the fresh assets.
    window.location.reload(true);
  },
  onOfflineReady() {
    console.log('App is ready to work offline');
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
