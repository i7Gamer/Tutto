# Tutto Multi-Device

Tutto Multi-Device is a dynamic web application that allows you to play the board game Tutto! with friends online in real-time or locally on the same device. It features modern UI design, real-time multiplayer synchronization using WebSockets, dynamic animations, and comprehensive statistics tracking.

## Tech Stack
- **Frontend**: React, Vite, CSS variables for theming, Chart.js for stats
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
