# Tutto Multi-Device

Tutto Multi-Device is a dynamic web application that allows you to play the board game Tutto! with friends online in real-time or locally on the same device. It features modern UI design, real-time multiplayer synchronization using WebSockets, dynamic animations, and comprehensive statistics tracking.

## Features
- **Local & Online Multiplayer:** Play on a single device or host/join an online room.
- **Physical & Digital Dice Modes:** Use the built-in digital dice with physics-inspired staggered tumbling animations, or track scores using your own physical dice.
- **Modern UI & Dark Mode:** A fully responsive, polished user interface with seamless dark mode integration.
- **Advanced Options:** Custom winning scores, customizable card deck counts, optional random player ordering, and turn/kick timers for online play.
- **Comprehensive Statistics:** Track global and personal device statistics, including Total Score, Total Turns, Busts, Longest Combos, and Most Tuttos per game. View detailed history records for your device.

## Tech Stack
- **Frontend**: React, Vite, Tailwind CSS, Framer Motion for animations, Chart.js for stats
- **Backend**: Node.js, Express, Socket.IO
- **Database**: SQLite (for global and personal statistics)

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/i7Gamer/TuttoNeu.git
   cd TuttoNeu
   ```

2. **Install dependencies:**
   Running `npm install` in the root folder will automatically install both the frontend dependencies and the backend dependencies (via the `postinstall` script).
   ```bash
   npm install
   ```

## Running the Application

You can launch both the frontend (Vite dev server) and the backend (Express + Socket.IO server) simultaneously with a single command:

```bash
npm run start
```

This will run them concurrently. By default:
- The frontend app will be available at `http://localhost:5173`
- The backend API and WebSocket server runs at `http://localhost:3000`

### Additional Scripts

- **`npm run dev`**: Starts only the Vite frontend dev server.
- **`npm run server`**: Starts only the Node.js backend server.
- **`npm run build`**: Builds the frontend app for production.
- **`npm run test`**: Runs the unit test suite.
