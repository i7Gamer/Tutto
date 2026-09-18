# Deploying Tutto

The published Docker image bundles everything: Express serves the frontend, the API and the WebSocket endpoint on a single port, so there is nothing else to run and no API URL to configure. Images are built for `linux/amd64` and `linux/arm64`, so a Raspberry Pi or an ARM NAS works the same as a normal server.

Running from source instead? See [Deploying from source](#deploying-from-source) below, and [development.md](development.md) for a development setup.

## Quick start

Generate a token, then start the container:

```bash
docker run -d \
  --name tutto \
  -p 3001:3001 \
  -v tutto-data:/data \
  -e API_TOKEN="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  i7gamer/tutto:latest
```

Open `http://localhost:3001`.

## With Docker Compose

Copy [docker-compose.yml](../docker-compose.yml) from this repository, put a generated `API_TOKEN` in a `.env` file beside it, then start it:

```bash
echo "API_TOKEN=$(openssl rand -hex 32)" > .env
```

```bash
docker compose up -d
```

Compose refuses to start if `API_TOKEN` is missing, so there is no accidental deployment with a guessable token.

## Configuration

All configuration is environment variables — the image contains no `.env` file.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `API_TOKEN` | **yes** | — | Guards the admin HTTP endpoints (`POST /api/stats/*`). Production requires at least 32 UTF-8 bytes, no surrounding whitespace, and no published placeholder. Generate with `openssl rand -hex 32`. |
| `CORS_ORIGIN` | with `TRUST_PROXY=1` | direct same-origin only | Complete public `http(s)` origin accepted by browser socket handshakes. Required behind a declared proxy in production; also set it when the frontend is hosted separately. Unset derives only the direct Host and socket scheme; forwarded origin headers are never trusted. `*` is refused in production. Origin-less native clients remain allowed. |
| `PORT` | no | `3001` | Port inside the container. |
| `TRUST_PROXY` | no | unset | Set to `1` **only** when the server sits behind exactly one reverse proxy: per-IP rate limiting then reads real client addresses from `X-Forwarded-For`. Leave unset for a directly exposed server (including LAN play) — trusting the header there would let clients forge their own rate-limit identities. A production start without it logs a one-line reminder. |
| `SOCKET_CONN_LIMIT_MAX` | no | `30` | Per-IP cap on new WebSocket connections per 10-second window. |
| `MAX_ROOMS_PER_ADDRESS` | no | `20` | Per-IP cap on rooms held open at once (the server holds 500 in total). Stops one client parking every slot with rooms whose players have "dropped". |
| `STATS_RATE_LIMIT_MAX` | no | `60` | Per-IP cap on GET requests to `/api/stats/*` per 60-second window. A valid device id also gets its own sub-bucket capped at this value, so one chatty device can't starve its neighbours' share of the shared IP bucket. |
| `MAX_CONCURRENT_TRANSPORTS` | no | `51000` | Global active Engine.IO transport ceiling, including clients that never complete Socket.IO setup. The default preserves the documented room/seat maximum plus reconnect overlap; it is not capacity-tuned. Lower after deployment measurement. |
| `ROOM_PUSH_WORK_LIMIT_MAX` | no | `100` | Authorized `pushState` attempts shared by all sockets in one room per second, including invalid/stale/no-op requests. |
| `ADMIN_AUTH_FAILURE_LIMIT_MAX` | no | `10` | Failed `API_TOKEN` attempts per client IP per 60 seconds, shared across both protected stats POST routes. Valid requests do not consume it. |
| `ADMIN_STATS_WRITE_LIMIT_MAX` | no | `60` | Valid-token admin stats POST requests per fixed 60-second window, shared across both routes, all devices and IPs. Positive safe integers only; anything else uses 60. See [Admin statistics write limit](#admin-statistics-write-limit). |
| `DB_PATH` | no | `/data/stats.db` | Location of the SQLite database. Change it only if you mount the volume elsewhere. |
| `TZ` | no | `UTC` | Affects timestamps in the container logs. |

The three per-IP caps (`SOCKET_CONN_LIMIT_MAX`, `MAX_ROOMS_PER_ADDRESS`, `STATS_RATE_LIMIT_MAX`) only need raising when one address legitimately stands for many players — a venue where everyone shares one NAT'd IP, say.

### Admin statistics write limit

The window starts at the first admitted valid-token request, belongs to one server process (it resets on restart and is not shared across replicas), and limits admission rather than concurrent writes — so roughly twice the limit can land around a window boundary. Exhaustion returns HTTP 429 with JSON `{ "error": "Too many requests" }` and a `Retry-After` in seconds; a 429 was refused before writing and may be retried after that delay. These updates are additive, not idempotent: do not automatically replay timeouts, lost responses or arbitrary 5xx errors, since a write may already have happened. Ordinary play, stats GETs and health checks are unaffected.

## Data and backups

Statistics live in a SQLite database at `/data/stats.db`, which the examples above keep in a named volume. Pulling a new image or recreating the container does not lose them; deleting the volume does.

A named volume like `tutto-data` needs no extra setup — Docker gives it to the `node` user automatically. A bind mount (`-v ./data:/data`) is different: the container runs as `node` (uid/gid 1000), and a host directory it does not own fails to open the database at startup. Before first use, run `chown -R 1000:1000 ./data` on the host.

SQLite uses write-ahead logging (WAL): committed statistics can still be in `stats.db-wal`, so copying only the live `stats.db` can lose data. Do not copy the live database and WAL files independently either; they can change between copies.

Schema migrations run automatically when a new version starts, in transactions, and preserve existing statistics — but an older image cannot open a database migrated by a newer one. Take the stopped backup below **before** an upgrade so it remains a copy of the old schema.

### Stopped backup (before an upgrade)

Finish active games and stop Tutto before copying, and stop any other process writing to the same database. Both deployment examples name the container `tutto`; `--volumes-from` uses its actual mounts, including Compose's project-prefixed volume name. Adjust the container name and `/data/stats.db` if you changed them.

```bash
(
  set -eu
  backup_dir="$(mktemp -d "$(pwd)/tutto-backup.XXXXXX")"
  docker stop tutto
  test "$(docker inspect --format '{{.State.ExitCode}}' tutto)" -eq 0
  docker run --rm --volumes-from tutto:ro -v "$backup_dir:/backup" alpine sh -eu -c '
    test ! -s /data/stats.db-wal
    cp /data/stats.db /backup/stats.db
  '
  printf 'Backup saved to %s/stats.db\n' "$backup_dir"
)
```

The checks require a clean shutdown and no remaining WAL content. If either fails, resolve the shutdown or other writer before copying; do not delete the WAL. Leave Tutto stopped until the backup succeeds, then follow [Updating](#updating). For a routine backup without an upgrade, restart it with `docker start tutto` after success. Stopping the server discards in-memory rooms.

### Online backup (without stopping games)

A temporary SQLite container can create a consistent snapshot using [`VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause). It reads the running container's database and WAL together and writes a fresh destination. The temporary container installs the SQLite CLI and needs network access for that.

```bash
(
  set -eu
  backup_dir="$(mktemp -d "$(pwd)/tutto-backup.XXXXXX")"
  docker run --rm -i --volumes-from tutto:ro -v "$backup_dir:/backup" alpine sh -eu <<'BACKUP'
apk add --no-cache sqlite
test -f /data/stats.db
test ! -e /backup/stats.db
sqlite3 -readonly /data/stats.db <<'SQL'
.bail on
.timeout 5000
VACUUM INTO '/backup/stats.db';
SQL
test "$(sqlite3 -readonly /backup/stats.db 'PRAGMA integrity_check;')" = ok
BACKUP
  printf 'Backup verified at %s/stats.db\n' "$backup_dir"
)
```

Each command creates a new backup directory. Keep only a backup whose command completed successfully; an interrupted `VACUUM INTO` can leave an incomplete destination. The online snapshot contains the committed statistics at its snapshot time, not the in-memory state of active games.

## Behind a reverse proxy

Point the proxy at the container's port and forward WebSocket upgrades (`Upgrade` and `Connection` headers) — the game will not sync without them. Set `CORS_ORIGIN` to the browser-visible public origin (for example `https://tutto.example.com`), especially when the proxy terminates TLS: the server deliberately does not derive it from forgeable forwarded Host/protocol headers. Set `TRUST_PROXY=1` so per-IP rate limiting sees real client addresses from `X-Forwarded-For` rather than the proxy's — it is deliberately not automatic, because a server that is *not* behind a proxy must ignore that header (any client can write it).

Terminating TLS here is also what makes the in-app QR scanner usable — browsers only grant camera access on a secure origin. Everything else works the same over plain http.

## Updating

Take the [stopped backup](#stopped-backup-before-an-upgrade) first, then pull and start the new image:

```bash
docker compose pull && docker compose up -d
```

Available tags: `latest` (current release), a pinned version such as `1.6.2`, and `nightly` (current `master`, released ahead of a version bump). Since `latest` and `nightly` both move, the running build names itself in the footer of the in-app wiki (the `?` button) — worth quoting in a bug report.

**Rolling back is one-way past a migration.** The database is upgraded in place on first start, and the schema does not go backwards. Starting an older image against a `/data` volume a newer one has already migrated fails at startup and, with `restart: unless-stopped`, keeps retrying; the log says the database was migrated by a newer version. Re-pull the newer tag to get back up, or restore the backup taken before the upgrade.

## Health

The container exposes a health check at `/api/health`, used by Docker's `HEALTHCHECK` and suitable for any external monitor. It performs no database work and is not rate limited.

## Building the image yourself

```bash
docker build -t tutto:local .
```

## Deploying from source

Set `API_TOKEN` to a strong random secret in your environment (e.g. `openssl rand -hex 32`), then run the combined build + server command:

```bash
npm run start:prod
```

This builds the frontend into `dist/`, then starts the Express server with `NODE_ENV=production`. The server serves the static frontend and refuses to start if `API_TOKEN` is missing. A production server uses `server/stats.db` (a development one uses `server/stats.dev.db`), unless `DB_PATH` points elsewhere; whichever file is in use is printed at startup.

In production, an unset `CORS_ORIGIN` means direct same-origin requests only. Set the explicit browser-visible origin when a reverse proxy terminates TLS or the frontend lives elsewhere; setting it to `*` is refused at startup.

### Restart safety

Rooms live in the server's memory, so restarting ends every game in progress. With `TUTTO_STATUS_LINE=1` the server keeps one line at the bottom of its console saying whether that would interrupt anyone:

```
[activity] idle — safe to restart
[activity] 1 game in progress · 4 players — DO NOT RESTART
[activity] 1 finished game awaiting stats — DO NOT RESTART
```

A restart is called unsafe while a game is being played, and while a finished game's statistics have not been submitted yet (each client sends its own device stats after the game ends, the host also sends the global stats, and the server writes a verdict-only row for any seat that left or was disconnected at the finish; stats are lost if the server goes away first). Set the variable on the one command you watch — `TUTTO_STATUS_LINE=1 npm run start:prod`, or `set TUTTO_STATUS_LINE=1` before it on Windows — rather than in `.env`, which every other start reads too.

On a terminal the line is rewritten in place, so it never scrolls; redirected to a file it prints one line per change instead. The variable is off by default, so Docker, CI and development servers log exactly as they otherwise would.
