# Tutto Multi-Device

Tutto Multi-Device is a dynamic web application that allows you to play the popular board game **Tutto!** with friends online in real-time or locally on the same device. It features modern UI design, real-time multiplayer synchronization using WebSockets, dynamic animations, multi-language support, and comprehensive statistics tracking.

## Features

- **Local & Online Multiplayer:** Play on a single device with friends, or host/join an online room and play over the internet in real-time.
- **Advanced Statistics & Leaderboards:** Track both global and personal device statistics. View advanced metrics such as total turns played, most busts (Note: Feuerwerk turns only count as a bust if 0 points are scored), fastest wins, fastest losses, highest turn scores, and the success rates of resolving challenging cards like Kniffel, Plus/Minus, and Kleeblatt.
- **Physical & Digital Dice Modes:** Use the built-in digital dice with physics-inspired staggered tumbling animations, or track scores using your own physical dice on the table.
- **Modern UI & Dark Mode:** A fully responsive, polished user interface built with TailwindCSS, featuring seamless dark mode integration, glassmorphism, floating labels, and dynamic micro-animations via Framer Motion.
- **Advanced Options:** Highly customizable game modes! Set custom winning scores, customize the card deck counts, randomize player turn orders, and configure precise turn/kick timers for online play.
- **Invite Links & QR Codes:** Share a room as a link, a share-sheet entry or a QR code instead of a code to read out. Rooms you have played in are remembered for one-tap rejoining. See [Inviting players](#inviting-players).
- **Keyboard Shortcuts:** Play a full turn without reaching for the mouse. See [Keyboard shortcuts](#keyboard-shortcuts).
- **Multi-Language Support (i18n):** Full support for English and German out of the box, with an extensible i18n configuration allowing for easy addition of more languages.
- **Robust Sync & Reconnects:** Online mode features robust state synchronization ensuring fair play. If you accidentally close your tab or lose connection, you'll be able to reconnect automatically within your configured reconnect timeout.

## Tech Stack

- **Frontend**: React, Vite, Tailwind CSS, Framer Motion for animations, Chart.js for stats, React-i18next for localization.
- **Backend**: Node.js, Express, Socket.IO.
- **Database**: SQLite, powered by Knex.js for migrations (for robust tracking of global and personal statistics).
- **Testing**: Vitest for unit and integration testing.
- **Deployment**: Multi-architecture Docker image (`linux/amd64`, `linux/arm64`) serving frontend, API and WebSockets from a single container.

## How to Play Tutto!

The objective of the game is to be the first player to reach the winning score (default is 6,000 points).

### The Basics
1. On your turn, you must first draw a card from the deck.
2. After drawing, you roll the dice to score points. You must score at least some points on every roll (either single 1s/5s or triples of the same number).
3. If you roll and score **nothing**, you "Bust" (also called a "Null"). You lose all points accumulated in this turn, and your turn ends immediately.
4. If you manage to score points with all 6 dice, you achieve a **"Tutto!"** and get the bonus if the card has one.

### The Cards
The drawn card dictates specific bonuses or rules for your turn:
- **x2**: If you roll a Tutto, your turn's score is doubled.
- **Plus/Minus**: If you roll a Tutto, you deduct 1,000 points from the current leader's score while getting 1,000 points  yourself!
- **Stop**: You cannot roll. Your turn ends immediately.
- **Feuerwerk**: You must keep rolling as long as you score points! You can't bank your score manually. You only stop when you bust, but you get to keep all points earned before busting.
- **Kleeblatt**: Roll two Tuttos in a row to instantly win the game!
- **Bonus Cards (200, 300, 400, 500, 600)**: If you roll a Tutto, you receive these bonus points added to your turn's score.

### Game modes: Modernized vs. Classic

The host picks one of two rule sets in the lobby. They differ in what happens after a Tutto:

- **Modernized** (the default — the app's original house rules): a completed card ends your turn immediately and banks the points. On Feuerwerk you choose which scoring dice to keep, and the Straight (Kniffel) must be built as a consecutive run from 1 upward or 6 downward.
- **Classic** (the official Abacusspiele rules): after any Tutto you may reveal the next card and keep rolling — points accumulate without limit, but a bust or a drawn Stop card forfeits the **whole** turn. A classic x2 doubles the entire accumulated total, a successful Plus/Minus adds exactly +1,000 (its leader deduction only applies if the turn actually banks, and never drops anyone below 0), Feuerwerk keeps every scoring die automatically and its ending null banks the entire accumulated turn, and any still-missing number counts toward the Straight — no consecutive order required.

Each rule set keeps its own statistics, records and win streaks (see below).

## Inviting players

A room is identified by a code you choose when you create it, and anyone who
enters the same code joins the same room. Four ways to get that code to someone,
in rough order of how little typing they involve:

| | How | Good for |
| --- | --- | --- |
| **Invite link** | Copy button next to the room name. Opens Tutto with the code already filled in — the guest only supplies their name. | Chat, email, anywhere you can paste. |
| **Share sheet** | Share button, on devices that have one. Same link, handed to the OS. | Phones. |
| **QR code** | QR button. Shows the same link as a code. | Someone sitting next to you: their phone's own camera app opens it, with Tutto uninvolved. |
| **Scanner** | Scan button beside the room-code field. | A guest who already has Tutto open and would rather not leave it. |

Rooms you have joined are remembered under the join form for one-tap rejoining.
The `×` beside an entry forgets it.

> **The scanner needs an https origin.** Browsers only grant camera access on
> secure connections, so on a plain-http LAN address it will say so and ask you
> to type the code instead. The other three ways work regardless — and a guest's
> own camera app can open the QR code on any origin, which is why it is the one
> to reach for at a table. See [Behind a reverse proxy](#behind-a-reverse-proxy)
> for putting the app on https.

> **A QR code is only as reachable as the address it was made from.** It encodes
> whatever URL the host is looking at, so if you opened Tutto on `localhost` the
> code points at the guest's own machine. The app says so when it spots this;
> open it on your network address instead.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `Space` / `Enter` | Whatever the primary button is right now — roll the dice, end your turn, answer Yes. |
| `R` | Roll again with the dice you have selected (inside the dice panel). |
| `S` | Stop and bank the dice you have selected (inside the dice panel). |
| `A` | Select every die in the current roll that scores. |

Shortcuts stay out of the way while you are typing in a field and while a dialog
is open, and a key does nothing when its button is greyed out. The same table is
in the in-app wiki, whose footer also names the running build — useful when
reporting a bug against `latest` or `nightly`.

## Run with Docker

The published image bundles everything: Express serves the frontend, the API and the WebSocket endpoint on a single port, so there is nothing else to run and no API URL to configure. Images are built for `linux/amd64` and `linux/arm64`, so a Raspberry Pi or an ARM NAS works the same as a normal server.

> Prefer to run from source, or want a development setup? See [Installation & Setup](#installation--setup) below.

### Quick start

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

### With Docker Compose

Copy [docker-compose.yml](docker-compose.yml) from this repository, put a generated `API_TOKEN` in a `.env` file beside it, then start it:

```bash
echo "API_TOKEN=$(openssl rand -hex 32)" > .env
```

```bash
docker compose up -d
```

Compose refuses to start if `API_TOKEN` is missing, so there is no accidental deployment with a guessable token.

### Configuration

All configuration is environment variables — the image contains no `.env` file.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `API_TOKEN` | **yes** | — | Guards the admin HTTP endpoints (`POST /api/stats/*`). Players never use it; they submit stats over the WebSocket. The server refuses to start without it, or if it is set to any placeholder published in this repository. Generate with `openssl rand -hex 32`. |
| `CORS_ORIGIN` | no | same-origin only | Set only if the frontend is served from a *different* origin than the API. Leaving it unset is correct for a normal deployment, including behind a reverse proxy on one domain. Setting it to `*` in production is refused at startup. |
| `PORT` | no | `3001` | Port inside the container. |
| `TRUST_PROXY` | no | unset | Set to `1` **only** when the server sits behind exactly one reverse proxy: per-IP rate limiting then reads real client addresses from `X-Forwarded-For`. Leave unset for a directly exposed server (including LAN play) — trusting the header there would let clients forge their own rate-limit identities. A production start without it logs a one-line reminder. |
| `DB_PATH` | no | `/data/stats.db` | Location of the SQLite database. Change it only if you mount the volume elsewhere. |
| `TZ` | no | `UTC` | Affects timestamps in the container logs. |

### Data and backups

Statistics live in a SQLite database at `/data/stats.db`, which the examples above keep in a named volume. Pulling a new image or recreating the container does not lose them; deleting the volume does.

To copy the database out for backup:

```bash
docker run --rm -v tutto-data:/data -v "$(pwd):/backup" alpine cp /data/stats.db /backup/stats.db
```

Schema migrations run automatically at startup, so upgrading is just pulling a newer image.

> One migration rebuilds the `device_statistics` table to split normal and custom games apart (SQLite cannot alter a primary key in place). It runs in a transaction and existing rows are carried over as normal games, but taking the backup above before that upgrade is worth the minute it costs.

### Behind a reverse proxy

Point the proxy at the container's port and forward WebSocket upgrades (`Upgrade` and `Connection` headers) — the game will not sync without them. Leave `CORS_ORIGIN` unset: the frontend is served by the same server, so it is already same-origin. Set `TRUST_PROXY=1` so per-IP rate limiting sees real client addresses from `X-Forwarded-For` rather than the proxy's — it is deliberately not automatic, because a server that is *not* behind a proxy must ignore that header (any client can write it).

Terminating TLS here is also what makes the in-app QR [scanner](#inviting-players) usable — browsers only grant camera access on a secure origin. Everything else works the same over plain http.

### Updating

```bash
docker compose pull && docker compose up -d
```

Available tags: `latest` (current release), a pinned version such as `1.1.3`, and `nightly` (current `master`, released ahead of a version bump).

Since `latest` and `nightly` both move, the running build names itself in the footer of the in-app wiki (the `?` button) — worth quoting in a bug report.

### Health

The container exposes a health check at `/api/health`, used by Docker's `HEALTHCHECK` and suitable for any external monitor. It performs no database work and is not rate limited.

### Building the image yourself

```bash
docker build -t tutto:local .
```

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone <repository_url>
   cd tutto
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` if you need to change the API token or port. See `.env.example` for descriptions of each variable. The defaults work for local development without any changes.

4. **Database Setup:**
   Migrations will run automatically when you start the server. The SQLite database is stored locally in the `server` directory, unless `DB_PATH` points somewhere else. A development server uses `server/stats.dev.db` and a production one (`npm run start:prod`, or the Docker image) uses `server/stats.db`, so running both on one machine keeps test games out of the real statistics. Whichever file is in use is printed at startup.

5. **Start the Development Server:**
   ```bash
   npm start
   ```
   This command starts both the Vite frontend server and the Node.js backend server simultaneously. (`npm run dev` starts only the Vite frontend, without the backend.)

6. **Open in Browser:**
   Navigate to `http://localhost:5173` in your browser.

## Production Deployment

[Docker](#run-with-docker) is the easiest route. To deploy from source instead:

1. Set `API_TOKEN` to a strong random secret in your environment (e.g. `openssl rand -hex 32`).
2. Run the combined build + server command:
   ```bash
   npm run start:prod
   ```
   This builds the frontend into `dist/`, then starts the Express server with `NODE_ENV=production`. The server serves the static frontend and refuses to start if `API_TOKEN` is missing.

In production, an unset `CORS_ORIGIN` means same-origin requests only, which is what you want when the frontend is served by this same server. Set it only if the frontend lives on a different origin; setting it to `*` is refused at startup.

## Testing

The project has comprehensive test coverage ranging from unit tests for the core game engine, to React component tests, and end-to-end integration tests.

To run the tests:
```bash
npm run test
```

## Advanced Options Explained

In the lobby, you can tweak the following:
- **Winning Score**: Change it from 6000 to shorter or longer games. *Makes the game custom.*
- **Turn Timer**: Limit how long a player has to take their turn online. (doubled for `Kleeblatt` and tripled for `Feuerwerk`)
- **Kick Timer**: Limit how long the room waits for a disconnected player to return before they are automatically kicked.
- **Deck Customization**: Add more `x2` cards, remove `Stop` cards, or tweak the deck composition to your liking. *Makes the game custom.*

### Normal and custom games

Statistics are kept in four buckets: each rule set (Modernized / Classic) has its own pair of **normal** and **custom** buckets, with its own records, win streaks and global row — classic games can never move the modernized figures, and vice versa.

Within a rule set, only games played on the default winning score (6000) and the default deck count as **normal**. Changing either one marks the game **custom**: it is still recorded in full, but in that rule set's separate custom bucket, and it contributes nothing to the global figures beyond a count of how many custom games have been played. The rule set itself does **not** make a game custom — it just picks which pair of buckets the game lands in.

The turn timer, the kick timer, random order and an enforced dice mode change how a game is paced and played, not what it takes to win it — a game using them still counts as normal. The lobby says so before you start, and the end screen says where the game went.

Local games record no statistics at all, whatever their configuration.

## License

Licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). The full text is in [COPYING](COPYING), with the copyright notice in [NOTICE](NOTICE).

Because Tutto is played over a network, the AGPL's network clause applies: if you run a modified version as a service others can reach, you must offer them the source of your modified version.

---
*Created with love for board games!*
