const { io } = require("socket.io-client");
const http = require("http");

async function runTest() {
  const socket1 = io("http://localhost:3001");
  const socket2 = io("http://localhost:3001");

  socket1.on('connect', () => {
    socket1.emit('joinRoom', { roomId: 'TESTROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, (res) => {
      console.log('Alice joined:', res.success);
      
      socket2.emit('joinRoom', { roomId: 'TESTROOM', name: 'Bob', deviceId: 'dev-bob', color: '#00ff00' }, (res2) => {
        console.log('Bob joined:', res2.success);
        
        // Alice starts the game
        // Simulating the pushState from Alice's client
        const mockPlayers = [
          { name: 'Alice', deviceId: 'dev-alice', socketId: socket1.id, disconnected: false, score: 0 },
          { name: 'Bob', deviceId: 'dev-bob', socketId: socket2.id, disconnected: false, score: 0 }
        ];
        socket1.emit('pushState', {
          roomId: 'TESTROOM',
          newState: {
            players: mockPlayers,
            status: 'playing',
            currentPlayerIndex: 0,
            reconnectTimeout: 2 // Set kick timer to 2 seconds
          }
        });
      });
    });
  });

  socket1.on('gameState', (state) => {
    console.log('GameState received by Alice. Bob disconnected status:', state.players.find(p => p.name === 'Bob')?.disconnected);
    console.log('Total players:', state.players.length);
  });

  socket1.on('playerDisconnected', (name) => {
    console.log('EVENT: playerDisconnected', name);
  });

  setTimeout(() => {
    console.log('Bob disconnecting...');
    socket2.disconnect();
  }, 2000);

  setTimeout(() => {
    console.log('Done testing.');
    process.exit(0);
  }, 6000);
}

runTest();
