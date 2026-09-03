# syntax=docker/dockerfile:1
#
# Single-container image: Express serves the built frontend, the HTTP API and
# the Socket.IO endpoint on one port, so there is no build-time API URL to
# configure — the client connects to window.location.origin.
#
# Base image note: node:24-slim (Debian bookworm, glibc 2.36) does NOT work.
# The sqlite3 prebuilt binary requires GLIBC_2.38, so it downloads without
# error and then fails to dlopen at container start. Alpine uses the musl
# prebuild, which is published for both x64 and arm64.

# Full major.minor.patch, matching .nvmrc's major (24) and ci.yml's
# node-version. Dependabot's docker ecosystem (.github/dependabot.yml) bumps
# this on a new release; server/packaging.test.ts pins the format and the
# major-version match.
ARG NODE_VERSION=24.20.0
# Pinned: tsx runs the TypeScript server directly. Installed with the server
# dependencies so the runtime CMD can load it as a node import hook.
ARG TSX_VERSION=4.23.13
ARG APP_PORT=3001

# ── Stage 1: build the frontend bundle ───────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips the root postinstall, which installs server/ deps that
# this stage never uses; the server workspace gets its own clean install below.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ── Stage 2: production server dependencies ──────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS server-deps
ARG TSX_VERSION
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
# Scripts must run here: sqlite3's install script is what fetches the prebuilt
# native binary. Without it npm would fall back to node-gyp, which Alpine has
# no toolchain for.
RUN npm ci --omit=dev
# tsx runs the TypeScript server directly (see the runtime CMD). It goes in this
# tree rather than npm's global prefix because `node --import tsx` is a bare
# specifier: node walks node_modules upward from the working directory and never
# looks at the global prefix. --no-save keeps it out of the manifest and the
# lockfile, which are the server's own dependency contract.
RUN npm install --no-save --omit=dev tsx@${TSX_VERSION}

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_PORT

LABEL org.opencontainers.image.title="Tutto" \
      org.opencontainers.image.description="Tutto scorecard and game manager — real-time multiplayer dice game" \
      org.opencontainers.image.source="https://github.com/i7Gamer/Tutto" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    PORT=${APP_PORT} \
    DB_PATH=/data/stats.db

WORKDIR /app

COPY --from=builder     --chown=node:node /app/dist                ./dist
# Installed at the image root, not under ./server: Node resolves bare imports
# by walking node_modules upward from the importing file, and the server also
# runs shared code from ./src, which can never reach ./server/node_modules.
# Also what puts tsx on the resolution path for the CMD below.
# server/packaging.test.ts asserts this destination.
COPY --from=server-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node server/*.ts server/package.json ./server/
COPY --chown=node:node server/migrations ./server/migrations
# The server imports shared game logic from src/ and playerColors.json from the
# repo root. server/packaging.test.ts asserts this list stays complete — if it
# fails, update these COPY lines and IMAGE_EXTERNAL_PATHS together.
COPY --chown=node:node src/types.ts ./src/types.ts
COPY --chown=node:node src/utils ./src/utils
COPY --chown=node:node playerColors.json ./playerColors.json
# AGPL: ship the licence and attribution alongside the binary distribution.
COPY --chown=node:node COPYING NOTICE ./

# The database lives outside the application directory so a volume mount cannot
# shadow the server sources it would otherwise sit next to (see DB_PATH).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE ${APP_PORT}

# Uses Node's global fetch, so the image needs no curl or wget. Points at
# /api/health, which does no database work and is not rate limited.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node, not the tsx CLI: that CLI runs the script in a forked child and relays
# signals to it over an IPC socket, allowing 30ms for an acknowledgement before
# it SIGKILLs the child. A container stopped while the event loop is busy would
# lose the ordered shutdown in server/shutdown.ts — the one thing it exists for.
# Loading tsx as an import hook keeps the server itself as PID 1, so `docker
# stop` signals it directly. server/packaging.test.ts pins the form; the smoke
# test in .github/workflows/docker-publish.yml proves the exit code.
#
# The server is run as TypeScript rather than compiled: tsconfig.server.json is
# noEmit, and knex resolves migrations/ as .js next to __dirname, so emitting
# would need a second tsconfig plus a migration-copy step.
CMD ["node", "--import", "tsx", "server/index.ts"]
