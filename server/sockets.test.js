/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io } from 'socket.io-client';
import { spawn } from 'child_process';

describe('Server Socket E2E Simulation', () => {
  let serverProcess;
  let socket1;
  let socket2;

  // We will run the server on port 3005 for testing
  const PORT = '3005';

  beforeAll(() => {
    return new Promise((resolve, reject) => {
      serverProcess = spawn('node', ['server/index.js'], {
        env: { ...process.env, PORT },
        stdio: 'pipe'
      });

      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Server running on port')) {
          resolve();
        }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error('Server stderr:', data.toString());
      });

      serverProcess.on('error', (err) => {
        reject(err);
      });
    });
  }, 10000);

  afterAll(() => {
    if (socket1) socket1.disconnect();
    if (socket2) socket2.disconnect();
    if (serverProcess) serverProcess.kill();
  });

  it('preserves socket metadata, detects disconnects, and kicks player correctly', () => {
    return new Promise((resolve, reject) => {
      socket1 = io(`http://127.0.0.1:${PORT}`);
      socket2 = io(`http://127.0.0.1:${PORT}`);

      socket1.on('connect_error', (err) => console.error('socket1 connect_error:', err));
      socket2.on('connect_error', (err) => console.error('socket2 connect_error:', err));

      let stateUpdates = 0;
      let bobDisconnectedNotified = false;

      let timeoutId = setTimeout(() => {
        reject(new Error(`Test timed out. stateUpdates=${stateUpdates}, bobDisconnectedNotified=${bobDisconnectedNotified}`));
      }, 9000);

      socket1.on('connect', () => {
        socket1.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Alice', deviceId: 'dev-alice', color: '#ff0000' }, (res) => {
          expect(res.success).toBe(true);
          
          socket2.emit('joinRoom', { roomId: 'E2E_ROOM', name: 'Bob', deviceId: 'dev-bob', color: '#00ff00' }, (res2) => {
            expect(res2.success).toBe(true);
            
            // Simulating Alice explicitly pushing state to start game
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-alice', socketId: socket1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-bob', socketId: socket2.id, disconnected: false, score: 0 }
            ];
            socket1.emit('pushState', {
              roomId: 'E2E_ROOM',
              newState: {
                players: mockPlayers,
                status: 'playing',
                currentPlayerIndex: 0,
                reconnectTimeout: 1 // Kick timer 1 second for fast testing
              }
            });
            
            // Wait a brief moment to ensure state was pushed before disconnecting
            setTimeout(() => {
              socket2.disconnect();
            }, 100);
          });
        });
      });

      socket1.on('playerDisconnected', (name) => {
        if (name === 'Bob') bobDisconnectedNotified = true;
      });

      socket1.on('gameState', (state) => {
        stateUpdates++;
        
        // Skip early states
        if (stateUpdates < 3) return;

        if (state.players.length === 1) {
          // Second check passed: player was kicked after timeout
          expect(state.players[0].name).toBe('Alice');
          expect(bobDisconnectedNotified).toBe(true);
          clearTimeout(timeoutId);
          resolve();
        }
      });
    });
  }, 10000);

  it('ignores pushState from a player who is neither host nor the active player', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`); // Alice — host + active player
      const s2 = io(`http://127.0.0.1:${PORT}`); // Bob — neither

      let bobPushObserved = false;
      const timeoutId = setTimeout(() => {
        // No 'hacked' state ever propagated → the malicious push was rejected.
        expect(bobPushObserved).toBe(false);
        s1.disconnect();
        s2.disconnect();
        resolve();
      }, 1500);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_AUTH', name: 'Alice', deviceId: 'dev-a3', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_AUTH', name: 'Bob', deviceId: 'dev-b3', color: '#00ff00' }, () => {
            const players = [
              { name: 'Alice', deviceId: 'dev-a3', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-b3', socketId: s2.id, disconnected: false, score: 0 }
            ];
            // Alice (host) legitimately starts the game; it's Alice's turn (index 0).
            s1.emit('pushState', { roomId: 'E2E_AUTH', newState: { players, status: 'playing', currentPlayerIndex: 0 } });

            setTimeout(() => {
              // Bob is not host and not the active player → this must be ignored.
              s2.emit('pushState', { roomId: 'E2E_AUTH', newState: { players: [], status: 'hacked', currentPlayerIndex: 0 } });
            }, 200);
          });
        });
      });

      s1.on('gameState', (state) => {
        if (state.status === 'hacked' || (state.players && state.players.length === 0)) {
          bobPushObserved = true;
          clearTimeout(timeoutId);
          reject(new Error('Server accepted pushState from an unauthorized player'));
        }
      });
    });
  }, 10000);

  it('does not send gameState to a player who just left the room intentionally', () => {
    return new Promise((resolve, reject) => {
      const s1 = io(`http://127.0.0.1:${PORT}`);
      const s2 = io(`http://127.0.0.1:${PORT}`);

      let s2GameStateCount = 0;
      let s1ReceivedBobLeft = false;

      let timeoutId = setTimeout(() => {
        reject(new Error(`Test timed out.`));
      }, 5000);

      s1.on('connect', () => {
        s1.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Alice', deviceId: 'dev-alice2', color: '#ff0000' }, () => {
          s2.emit('joinRoom', { roomId: 'E2E_ROOM_LEAVE', name: 'Bob', deviceId: 'dev-bob2', color: '#00ff00' }, () => {
            const mockPlayers = [
              { name: 'Alice', deviceId: 'dev-alice2', socketId: s1.id, disconnected: false, score: 0 },
              { name: 'Bob', deviceId: 'dev-bob2', socketId: s2.id, disconnected: false, score: 0 }
            ];
            s1.emit('pushState', {
              roomId: 'E2E_ROOM_LEAVE',
              newState: { players: mockPlayers, status: 'playing' }
            });
            
            setTimeout(() => {
              // Setup listener for Bob *before* he leaves, to catch any synchronous rogue broadcasts
              s2.on('gameState', () => {
                s2GameStateCount++;
              });
              
              // Bob intentionally leaves the room
              s2.emit('leaveRoom');
            }, 100);
          });
        });
      });

      s1.on('gameState', (state) => {
        // Once Alice receives the updated gameState showing Bob is gone, we wait 500ms and check s2.
        if (state.players && state.players.length === 1 && state.players[0].name === 'Alice') {
          if (s1ReceivedBobLeft) return;
          s1ReceivedBobLeft = true;
          setTimeout(() => {
            expect(s2GameStateCount).toBe(0); // Bob should have received 0 gameState updates after leaving
            clearTimeout(timeoutId);
            s1.disconnect();
            s2.disconnect();
            resolve();
          }, 500);
        }
      });
    });
  }, 10000);
});
