# Developing Tutto

## Setup

Requires Node 22 or newer (24 recommended and pinned in `.nvmrc`); `engine-strict` makes `npm install` refuse an older major.

```bash
git clone <repository_url>
cd tutto
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:5173`.

- `npm start` runs the Vite frontend and the Node.js backend together; `npm run dev` starts only the frontend.
- The defaults in `.env.example` work for local development unchanged; edit `.env` to change the API token or port.
- Migrations run automatically when the server starts. A development server uses `server/stats.dev.db` and a production one (`npm run start:prod`, or the Docker image) uses `server/stats.db`, so running both on one machine keeps test games out of the real statistics. Whichever file is in use is printed at startup.

Deploying a build is covered in [deployment.md](deployment.md).

## Testing

Unit and component tests run under Vitest:

```bash
npm run test
```

The end-to-end suite is separate, and runs against a production build served by the real server in Chromium, Firefox and WebKit. It needs its browsers downloaded once (and again after any Playwright upgrade):

```bash
npx playwright install
```

```bash
npm run test:e2e
```

## Continuous Integration

Every push and pull request against `master` runs the GitHub Actions checks defined in `.github/workflows/ci.yml`: **Type Check, Lint & Test** and an **End-to-End Tests** leg per browser engine (chromium, firefox, webkit — webkit currently split across two shard legs), all run in parallel. All are bounded by `timeout-minutes`, and the workflow cancels a superseded run on the same branch instead of queuing behind it.
