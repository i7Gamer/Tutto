# Tutto Multi-Device

Tutto Multi-Device is a dynamic web application that allows you to play the popular board game **Tutto!** with friends online in real-time or locally on the same device. It features modern UI design, real-time multiplayer synchronization using WebSockets, dynamic animations, multi-language support, and comprehensive statistics tracking.

## Features

- **Local & Online Multiplayer:** Play on a single device with friends, or host/join an online room and play over the internet in real-time.
- **Advanced Statistics & Leaderboards:** Track both global and personal device statistics. View advanced metrics such as total turns played, most busts (Note: Feuerwerk turns only count as a bust if 0 points are scored), fastest wins, fastest losses, highest turn scores, and the success rates of resolving challenging cards like Kniffel, Plus/Minus, and Kleeblatt.
- **Physical & Digital Dice Modes:** Use the built-in digital dice with physics-inspired staggered tumbling animations, or track scores using your own physical dice on the table.
- **Modern UI & Dark Mode:** A fully responsive, polished user interface built with TailwindCSS, featuring seamless dark mode integration, glassmorphism, floating labels, and dynamic micro-animations via Framer Motion.
- **Advanced Options:** Highly customizable game modes! Set custom winning scores, customize the card deck counts, randomize player turn orders, and configure precise turn/kick timers for online play.
- **Multi-Language Support (i18n):** Full support for English and German out of the box, with an extensible i18n configuration allowing for easy addition of more languages.
- **Robust Sync & Reconnects:** Online mode features robust state synchronization ensuring fair play. If you accidentally close your tab or lose connection, you'll be able to reconnect automatically within your configured reconnect timeout.

## Tech Stack

- **Frontend**: React, Vite, Tailwind CSS, Framer Motion for animations, Chart.js for stats, React-i18next for localization.
- **Backend**: Node.js, Express, Socket.IO.
- **Database**: SQLite, powered by Knex.js for migrations (for robust tracking of global and personal statistics).
- **Testing**: Vitest for unit and integration testing.

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
   Migrations will run automatically when you start the server. The SQLite database is stored locally in the `server` directory.

5. **Start the Development Server:**
   ```bash
   npm run dev
   ```
   This command starts both the Vite frontend server and the Node.js backend server simultaneously.

6. **Open in Browser:**
   Navigate to `http://localhost:5173` in your browser.

## Production Deployment

1. Set `TUTTO_API_TOKEN` and `VITE_API_TOKEN` to the same strong random secret in your environment (e.g. `openssl rand -hex 32`).
2. Run the combined build + server command:
   ```bash
   npm run start:prod
   ```
   This builds the frontend into `dist/`, then starts the Express server with `NODE_ENV=production`. The server serves the static frontend and refuses to start if `TUTTO_API_TOKEN` is missing.

## Testing

The project has comprehensive test coverage ranging from unit tests for the core game engine, to React component tests, and end-to-end integration tests.

To run the tests:
```bash
npm run test
```

## Advanced Options Explained

In the lobby, you can tweak the following:
- **Winning Score**: Change it from 6000 to shorter or longer games.
- **Turn Timer**: Limit how long a player has to take their turn online. (doubled for `Kleeblatt` and tripled for `Feuerwerk`)
- **Kick Timer**: Limit how long the room waits for a disconnected player to return before they are automatically kicked.
- **Deck Customization**: Add more `x2` cards, remove `Stop` cards, or tweak the deck composition to your liking.

---
*Created with love for board games!*
