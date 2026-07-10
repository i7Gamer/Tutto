import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// How long a navigation waits for the network before falling back to the
// cached HTML shell (offline PWA start / dead connection).
const NAVIGATION_NETWORK_TIMEOUT_S = 3

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Falls back to localhost for local dev. Set ALLOWED_HOST to the deployed
  // domain in production (e.g. ALLOWED_HOST=tutto.rzipas.win) — Vite's dev/
  // preview server otherwise rejects requests whose Host header doesn't
  // match one of allowedHosts.
  const allowedHost = env.ALLOWED_HOST || 'localhost'

  return {
    base: './',
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          // The HTML shell is deliberately NOT precached (no 'html' here) and
          // navigateFallback is disabled: navigations go NetworkFirst below,
          // so a new deploy reaches every client on its next launch instead
          // of flashing the stale cached shell and force-reloading once the
          // service worker updates. The cached copy still serves when the
          // network doesn't answer in time (offline PWA start).
          globPatterns: ['**/*.{js,css,png,svg,webmanifest}'],
          globIgnores: ['**/assets/old/**'],
          skipWaiting: true,
          clientsClaim: true,
          navigateFallback: null,
          runtimeCaching: [
            {
              // Serialized into the generated service worker — must stay
              // self-contained (no closure variables).
              urlPattern: ({ request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: { cacheName: 'html-cache', networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_S }
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: { cacheName: 'google-fonts-cache', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } }
            }
          ]
        },
        manifest: {
          name: 'Tutto Game',
          short_name: 'Tutto',
          description: 'Tutto scorecard and game manager',
          theme_color: '#4f46e5',
          // Rendered from public/favicon.svg — see scripts/generate-icons.mjs.
          // The previous config declared the 200x200 logo.png as both the 192
          // and 512 icon, so installed-app icons rendered upscaled and blurry.
          icons: [
            {
              src: 'assets/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'assets/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: 'assets/icon-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable'
            }
          ]
        }
      })
    ],
    server: {
      allowedHosts: [allowedHost],
      proxy: {
        '/api': 'http://localhost:3001',
        '/socket.io': {
          target: 'ws://localhost:3001',
          ws: true
        }
      }
    },
    preview: {
      allowedHosts: [allowedHost]
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react'
            if (id.includes('node_modules/zustand/')) return 'zustand'
            if (id.includes('node_modules/chart.js/') || id.includes('node_modules/react-chartjs-2/')) return 'charts'
            if (id.includes('node_modules/i18next/') || id.includes('node_modules/react-i18next/')) return 'i18n'
            if (id.includes('node_modules/socket.io-client/')) return 'socket'
            if (id.includes('node_modules')) return 'vendor'
          }
        }
      },
      chunkSizeWarningLimit: 600
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/setupTests.tsx'],
      exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'e2e/**', 'server/node_modules/**'],
      env: {
        TEST_DB: 'true'
      }
    }
  }
})
