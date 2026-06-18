import React, { useState } from 'react';
import { UserPlus, Trash2, Settings, Play, Globe, User } from 'lucide-react';

export default function Home({ game, mode, setMode }) {
  const { players, addPlayer, removePlayer, startGame, winningScore, setWinningScore, initialCards, setInitialCards, isOnline, isHost, joinRoom, roomId, myName } = game;
  const [newPlayerName, setNewPlayerName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inputRoomCode, setInputRoomCode] = useState("");
  const [inputName, setInputName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const handleAddPlayer = () => {
    if (newPlayerName.trim() === "") return;
    addPlayer(newPlayerName.trim());
    setNewPlayerName("");
  };

  const updateCardCount = (card, count) => {
    setInitialCards(prev => ({ ...prev, [card]: parseInt(count) || 0 }));
  };

  const handleJoin = async () => {
    if (!inputRoomCode || !inputName) return;
    setErrorMsg("");
    const res = await joinRoom(inputRoomCode, inputName);
    if (res && res.error) {
      setErrorMsg(res.error);
    }
  };

  return (
    <div className="container">
      <div className="glass-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1>Tutto</h1>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', justifyContent: 'center' }}>
          <button className={`btn ${mode === 'local' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setMode('local')}>
            <User size={18} /> Local Play
          </button>
          <button className={`btn ${mode === 'online' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setMode('online')}>
            <Globe size={18} /> Online Play
          </button>
        </div>

        {mode === 'local' ? (
          <>
            <div style={{ marginBottom: '2rem' }}>
              <h3>Players</h3>
              <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <input 
                  type="text" 
                  placeholder="Name of new player" 
                  value={newPlayerName} 
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-primary" onClick={handleAddPlayer}>
                  <UserPlus size={18} /> Add
                </button>
              </div>

              {players && players.length > 0 && (
                <div className="table-responsive" style={{ marginTop: '1rem' }}>
                  <table>
                    <tbody>
                      {players.map(p => (
                        <tr key={p.name}>
                          <td style={{ fontWeight: 600 }}>{p.name}</td>
                          <td style={{ width: '50px', textAlign: 'center' }}>
                            <button className="btn btn-outline" style={{ padding: '0.4rem', border: 'none', color: 'var(--danger)' }} onClick={() => removePlayer(p.name)}>
                              <Trash2 size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
              <button className="btn btn-outline" onClick={() => setShowAdvanced(!showAdvanced)}>
                <Settings size={18} /> {showAdvanced ? "Hide" : "Show"} Advanced Options
              </button>
            </div>

            {showAdvanced && (
              <div style={{ marginBottom: '2rem', padding: '1rem', background: 'var(--bg-color)', borderRadius: '8px' }}>
                <div className="input-group">
                  <label>Winning Score</label>
                  <input type="number" value={winningScore} onChange={(e) => setWinningScore(parseInt(e.target.value) || 0)} />
                </div>

                <h4 style={{ marginTop: '1.5rem', marginBottom: '1rem' }}>Cards in Deck</h4>
                <div className="grid-cols-2">
                  {initialCards && Object.keys(initialCards).map(card => (
                    <div className="input-group" key={card}>
                      <label>{card.replace("_", "/")}</label>
                      <input type="number" value={initialCards[card]} onChange={(e) => updateCardCount(card, e.target.value)} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {players && players.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button className="btn btn-success" style={{ width: '100%', fontSize: '1.25rem', padding: '1rem' }} onClick={startGame}>
                  <Play size={24} /> Start Game!
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {!roomId ? (
              <div style={{ marginBottom: '2rem' }}>
                <h3>Join or Create Room</h3>
                <div className="input-group">
                  <label>Room Code</label>
                  <input type="text" value={inputRoomCode} onChange={(e) => setInputRoomCode(e.target.value)} placeholder="e.g. 1234" />
                </div>
                <div className="input-group">
                  <label>Your Name</label>
                  <input type="text" value={inputName} onChange={(e) => setInputName(e.target.value)} placeholder="e.g. Alice" />
                </div>
                {errorMsg && <div style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{errorMsg}</div>}
                <button className="btn btn-primary" onClick={handleJoin} style={{ width: '100%' }}>Join / Create</button>
              </div>
            ) : (
              <div style={{ marginBottom: '2rem' }}>
                <h3>Room: {roomId}</h3>
                <p>You are: <strong>{myName}</strong> {isHost ? "(Host)" : ""}</p>
                
                <h4>Players in Lobby:</h4>
                <div className="table-responsive" style={{ marginTop: '1rem' }}>
                  <table>
                    <tbody>
                      {players && players.map(p => (
                        <tr key={p.name}>
                          <td style={{ fontWeight: 600 }}>{p.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {isHost && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
                      <button className="btn btn-outline" onClick={() => setShowAdvanced(!showAdvanced)}>
                        <Settings size={18} /> {showAdvanced ? "Hide" : "Show"} Advanced Options
                      </button>
                    </div>

                    {showAdvanced && (
                      <div style={{ marginBottom: '2rem', padding: '1rem', background: 'var(--bg-color)', borderRadius: '8px' }}>
                        <div className="input-group">
                          <label>Winning Score</label>
                          <input type="number" value={winningScore} onChange={(e) => setWinningScore(parseInt(e.target.value) || 0)} />
                        </div>

                        <h4 style={{ marginTop: '1.5rem', marginBottom: '1rem' }}>Cards in Deck</h4>
                        <div className="grid-cols-2">
                          {initialCards && Object.keys(initialCards).map(card => (
                            <div className="input-group" key={card}>
                              <label>{card.replace("_", "/")}</label>
                              <input type="number" value={initialCards[card]} onChange={(e) => updateCardCount(card, e.target.value)} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {isHost ? (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button className="btn btn-success" style={{ width: '100%', fontSize: '1.25rem', padding: '1rem' }} onClick={startGame} disabled={!players || players.length === 0}>
                      <Play size={24} /> Start Game!
                    </button>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--primary)', fontWeight: 'bold' }}>
                    Waiting for host to start the game...
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
