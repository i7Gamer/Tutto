import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Read rather than imported: an `import pkg from './package.json'` would end up
// in the bundle. Exposed to the app as __APP_VERSION__ (see src/utils/appVersion.ts,
// declared in src/vite-env.d.ts) and asserted against the manifest in its test.
const { version: appVersion } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
)

// Packages reached only through a dynamic import. Kept out of the manual chunk
// assignment below so the split actually happens — see the note there.
const LAZY_PACKAGES = ['qrcode-generator', 'jsqr']

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Falls back to localhost for local dev. Set ALLOWED_HOST to the deployed
  // domain in production (e.g. ALLOWED_HOST=tutto.example.com) — Vite's dev/
  // preview server otherwise rejects requests whose Host header doesn't
  // match one of allowedHosts.
  const allowedHost = env.ALLOWED_HOST || 'localhost'

  // Where the dev server forwards /api and /socket.io. This was hardcoded, so
  // a dev session always talked to whatever answered on 3001 — which on a
  // machine that also runs the real thing is the real thing. It is not only
  // reads: crashLog.ts POSTs client errors to /api/log/client-error, so an
  // error from a half-saved file ends up in that instance's log. Point
  // API_TARGET at a scratch server to keep a dev session to itself.
  const apiTarget = env.API_TARGET || 'http://localhost:3001'
  // Same host, socket scheme: http→ws, https→wss.
  const socketTarget = apiTarget.replace(/^http/, 'ws')

  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [
      react(),
      VitePWA({
        // injectManifest, not the default generateSW: the generated worker's
        // workbox runtime does not survive this toolchain's bundling — it
        // registers and claims clients while precaching silently never installs,
        // so nothing ever worked offline. src/sw.js owns the behaviour instead
        // and explains the evidence. This mode only injects the file list.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.js',
        registerType: 'autoUpdate',
        injectManifest: {
          // index.html is precached here, unlike before: it is what an offline
          // start serves. Staleness is not a risk because src/sw.js tries the
          // network first for navigations and only falls back to this copy.
          globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
          globIgnores: ['**/assets/old/**'],
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
        '/api': apiTarget,
        '/socket.io': {
          target: socketTarget,
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
            // Returning nothing leaves these to the default chunking, which
            // honours dynamic imports. The catch-all vendor rule at the bottom
            // would otherwise pull them into the bundle every player
            // downloads, silently undoing the lazy import at their call sites
            // — the QR encoder (RoomQrCode.tsx) and the QR decoder
            // (useQrScanner.ts), neither of which most players ever need.
            if (LAZY_PACKAGES.some(pkg => id.includes(`node_modules/${pkg}/`))) return
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
      // scratch/ is the gitignored home for throwaway local scripts (see
      // .gitignore). Anything test-shaped left there — a Playwright spec
      // pulled aside to debug something, say — is collected by this runner
      // and fails the whole suite with "Playwright Test did not expect
      // test.describe() to be called here", for a file that is not part of
      // the project at all.
      exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'e2e/**', 'server/node_modules/**', 'scratch/**'],
      env: {
        TEST_DB: 'true',
        // Makes testDelay(ms) in socket/server integration tests scale down
        // orchestration sleeps (e.g. 300ms → 60ms) in the same way TEST_TIMER_SCALE
        // already accelerates the spawned server child processes.
        TEST_TIMER_SCALE: '0.2',
        // The per-IP socket connection limiter (see socketHandlers.ts) would
        // otherwise trip on the suites' bursts of local connections, which all
        // arrive from 127.0.0.1. Inherited by the spawned server child
        // processes too (they spread process.env). The limiter itself is
        // covered by dedicated tests that set a low limit explicitly.
        SOCKET_CONN_LIMIT_MAX: '1000000',
      }
    }
  }
})
