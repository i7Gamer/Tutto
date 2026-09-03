import { readFileSync } from 'node:fs'
// vitest/config rather than vite: same defineConfig, plus the type for the
// `test` block below.
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Read rather than imported: an `import pkg from './package.json'` would end up
// in the bundle. Exposed to the app as __APP_VERSION__ (see src/utils/appVersion.ts,
// declared in src/vite-env.d.ts) and asserted against the manifest in its test.
const { version: appVersion } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

// Packages reached only through a dynamic import. Kept out of the manual chunk
// assignment below so the split actually happens — see the note there.
const LAZY_PACKAGES = ['qrcode-generator', 'jsqr', 'chart.js', 'react-chartjs-2']

// Coverage gate for `npm run test:coverage` (which CI runs): five points
// under the lowest of the four metrics actually measured over the whole
// tree (see `include` on the `coverage` block below) — 95.93% statements /
// 91.43% branches / 97.57% functions / 97.52% lines as of v1.5.4, branches
// the lowest. Five points of headroom catches real erosion without turning
// every refactor into a threshold fight.
const COVERAGE_FLOOR_PERCENT = 86

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
      // Tailwind as a Vite plugin rather than through PostCSS: it is the
      // faster path, and it takes autoprefixer's job with it (v4 prefixes via
      // Lightning CSS), so the project needs no postcss.config.js at all.
      tailwindcss(),
      VitePWA({
        // injectManifest, not the default generateSW: the generated worker's
        // workbox runtime does not survive this toolchain's bundling — it
        // registers and claims clients while precaching silently never installs,
        // so nothing ever worked offline. src/sw.js owns the behaviour instead
        // and explains the evidence. This mode only injects the file list.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.js',
        // 'prompt', not 'autoUpdate'. In auto mode the plugin's own register
        // template reloads the page on every worker activation where
        // `isUpdate || isExternal` — so one tab updating yanked every other
        // open tab and PWA window, the browser's periodic sw.js re-check could
        // reload a tab with no deploy behind it at all, and nothing guarded a
        // second reload when the edge briefly served the previous sw.js again.
        // In prompt mode onNeedRefresh becomes live and src/main.tsx decides
        // WHEN (see src/utils/swUpdate.ts) — which is what main.tsx's comment
        // always claimed.
        registerType: 'prompt',
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
          // The light theme's actual header/page colours — see the note
          // above --primary and --bg-color in src/index.css for why neither
          // is a literal a config file can just import, and
          // src/pwaManifestColors.test.ts for what keeps these two in sync
          // with that stylesheet instead. theme_color was previously
          // '#4f46e5', the Tailwind v3 hex for indigo-600 kept by hand; v4
          // redefined the palette in OKLCH and left this one behind (exactly
          // the drift --secondary's own comment in index.css warns about) —
          // #4f39f6 is indigo-600's actual v4 colour.
          theme_color: '#4f39f6',
          background_color: '#f4f7f6',
          // vite-plugin-pwa defaults this to 'en' unless overridden; the app
          // is bilingual (see src/i18n.test.ts), so no single lang applies.
          // `undefined` here (rather than omitting the key) overrides that
          // default — JSON.stringify then drops it from the generated file.
          lang: undefined,
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
          manualChunks: (id: string) => {
            // Returning nothing leaves these to the default chunking, which
            // honours dynamic imports. The catch-all vendor rule at the bottom
            // would otherwise pull them into the bundle every player
            // downloads, silently undoing the lazy import at their call sites
            // — the QR encoder (RoomQrCode.tsx) and the QR decoder
            // (useQrScanner.ts), neither of which most players ever need.
            if (LAZY_PACKAGES.some(pkg => id.includes(`node_modules/${pkg}/`))) return
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react'
            if (id.includes('node_modules/zustand/')) return 'zustand'
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
      exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'e2e/**', 'server/node_modules/**', 'scratch/**', '.claude/**'],
      coverage: {
        // Without `include`, V8 coverage only reports on files some test
        // actually imported — an untested file simply never appears, so it
        // cannot drag the percentage down and the floor above measured
        // nothing like "the whole tree". Once `include` is set, the v8
        // provider always folds in every matching-but-untested file as 0%
        // (see getUntestedFiles in @vitest/coverage-v8) — there is no
        // separate `all` toggle to opt into that in this vitest version; one
        // existed in older istanbul-only releases but isn't part of the
        // current CoverageOptions type at all.
        include: ['src/**/*.{ts,tsx}', 'server/**/*.ts'],
        exclude: [
          '**/*.test.*',
          '**/*.d.ts',
          'src/testing/**',
          'src/sw.js',
          // Every one of these lives only in a subprocess a spawned-server
          // suite starts (see socketTestHarness.ts) — V8 coverage instruments
          // the parent process, so it cannot see into that child at all, and
          // counting these against the floor would penalize files that ARE
          // exercised, just not visibly.
          'server/socketTestHarness.ts',
          'server/testPorts.ts',
          'server/index.ts',
        ],
        thresholds: {
          statements: COVERAGE_FLOOR_PERCENT,
          branches: COVERAGE_FLOOR_PERCENT,
          functions: COVERAGE_FLOOR_PERCENT,
          lines: COVERAGE_FLOOR_PERCENT,
        },
      },
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
        // Same reason, for the per-address room cap (rooms.ts): every room a
        // suite creates is created from 127.0.0.1, so the 20-room default
        // would refuse the 21st. socketRoomAddressCap.test.ts sets its own
        // low value explicitly, which is where the cap is actually covered.
        MAX_ROOMS_PER_ADDRESS: '1000000',
        // Same reason again, for the per-IP /api/stats GET rate limit
        // (api.ts): sockets.stats.test.ts polls that endpoint up to ~75
        // times per assertion, all from 127.0.0.1 against one spawned server
        // process, so a single slow-to-land write used to run its polling
        // helper out to the production default and 429 every test after it
        // in the same 60s window — all individually passing, but cascading
        // once one of them was genuinely slow or failing.
        STATS_RATE_LIMIT_MAX: '1000000',
      }
    }
  }
})
