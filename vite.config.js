import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        globIgnores: ['**/assets/old/**'],
        skipWaiting: true,
        clientsClaim: true,
        // Don't cache the HTML entry point — always fetch it fresh from network
        navigateFallbackDenylist: [],
        runtimeCaching: [
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
        icons: [
          {
            src: 'assets/logo.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'assets/logo.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  server: {
    allowedHosts: ["tutto.rzipas.win"],
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  },
  preview: {
    allowedHosts: ["tutto.rzipas.win"]
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.jsx'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'e2e/**', 'server/node_modules/**'],
    env: {
      TEST_DB: 'true'
    }
  }
})
