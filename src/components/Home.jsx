import React, { useState } from 'react';
import { UserPlus, Trash2, Settings, Play, Globe, User, Crown, ChevronUp, ChevronDown, UserMinus, BarChart2 } from 'lucide-react';

export default function Home({ game, mode, setMode, onShowStats }) {
  const { players, addPlayer, removePlayer, startGame, winningScore, setWinningScore, initialCards, setInitialCards, isOnline, isHost, hostId, joinRoom, leaveRoom, roomId, myName, kickPlayer, reorderPlayers, randomOrder, setRandomOrder } = game;
  const [newPlayerName, setNewPlayerName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inputRoomCode, setInputRoomCode] = useState(() => localStorage.getItem('tutto_last_room') || "");
  const [inputName, setInputName] = useState(() => localStorage.getItem('tutto_last_name') || "");
  const [errorMsg, setErrorMsg] = useState("");

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (trimmedName === "") return;
    
    if (players.some(p => p.name.toLowerCase() === trimmedName.toLowerCase())) {
      alert("A player with this name already exists!");
      return;
    }
    
    addPlayer(trimmedName);
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
    } else {
      localStorage.setItem('tutto_last_room', inputRoomCode);
      localStorage.setItem('tutto_last_name', inputName);
    }
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newPlayers = [...players];
    [newPlayers[index - 1], newPlayers[index]] = [newPlayers[index], newPlayers[index - 1]];
    reorderPlayers(newPlayers);
  };

  const handleMoveDown = (index) => {
    if (index === players.length - 1) return;
    const newPlayers = [...players];
    [newPlayers[index + 1], newPlayers[index]] = [newPlayers[index], newPlayers[index + 1]];
    reorderPlayers(newPlayers);
  };

  const handleModeChange = (newMode) => {
    if (newMode === 'local' && roomId) {
      if (window.confirm("Do you really want to leave the room?")) {
        leaveRoom();
        setMode('local');
      }
    } else {
      setMode(newMode);
    }
  };

  return (
    <div className="container">
      <div className="glass-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1>Tutto</h1>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', justifyContent: 'center' }}>
          <button className={`btn ${mode === 'local' ? 'btn-primary' : 'btn-outline'}`} onClick={() => handleModeChange('local')}>
            <User size={18} /> Local Play
          </button>
          <button className={`btn ${mode === 'online' ? 'btn-primary' : 'btn-outline'}`} onClick={() => handleModeChange('online')}>
            <Globe size={18} /> Online Play
          </button>
        </div>

        {!(mode === 'online' && roomId) && (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
            <button className="btn btn-outline" onClick={onShowStats} style={{ width: '100%', maxWidth: '300px' }}>
              <BarChart2 size={18} /> View Statistics
            </button>
          </div>
        )}

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
                      {players.map((p, idx) => (
                        <tr key={p.name}>
                          <td style={{ fontWeight: 600 }}>{p.name}</td>
                          <td style={{ width: '130px', textAlign: 'right' }}>
                            {idx > 0 && (
                              <button className="btn btn-outline" style={{ padding: '0.2rem', marginRight: '0.2rem' }} onClick={() => handleMoveUp(idx)}>
                                <ChevronUp size={16} />
                              </button>
                            )}
                            {idx < players.length - 1 && (
                              <button className="btn btn-outline" style={{ padding: '0.2rem', marginRight: '0.5rem' }} onClick={() => handleMoveDown(idx)}>
                                <ChevronDown size={16} />
                              </button>
                            )}
                            <button className="btn btn-outline" style={{ padding: '0.2rem', color: 'var(--danger)' }} onClick={() => removePlayer(p.name)}>
                              <Trash2 size={16} />
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

                <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', marginTop: '1rem' }}>
                  <input type="checkbox" id="localRandomOrder" checked={randomOrder ?? true} onChange={(e) => setRandomOrder(e.target.checked)} style={{ width: 'auto', marginRight: '0.5rem' }} />
                  <label htmlFor="localRandomOrder" style={{ marginBottom: 0 }}>Random Order</label>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>Room: {roomId}</h3>
                  <button className="btn btn-outline" style={{ color: 'var(--danger)', padding: '0.5rem 1rem' }} onClick={() => {
                    if(window.confirm("Do you really want to leave the room?")) leaveRoom();
                  }}>
                    Leave Room
                  </button>
                </div>
                <p>You are: <strong>{myName}</strong> {isHost ? "(Host)" : ""}</p>
                
                <h4>Players in Lobby:</h4>
                <div className="table-responsive" style={{ marginTop: '1rem' }}>
                  <table>
                    <tbody>
                      {players && players.map((p, idx) => (
                        <tr key={p.name}>
                          <td style={{ fontWeight: 600 }}>
                            {p.name} {p.socketId === hostId ? <Crown size={16} color="gold" style={{ marginLeft: 8, verticalAlign: 'middle' }} /> : null}
                          </td>
                          {isHost && (
                            <td style={{ width: '130px', textAlign: 'right' }}>
                              {idx > 0 && (
                                <button className="btn btn-outline" style={{ padding: '0.2rem', marginRight: '0.2rem' }} onClick={() => handleMoveUp(idx)}>
                                  <ChevronUp size={16} />
                                </button>
                              )}
                              {idx < players.length - 1 && (
                                <button className="btn btn-outline" style={{ padding: '0.2rem', marginRight: '0.5rem' }} onClick={() => handleMoveDown(idx)}>
                                  <ChevronDown size={16} />
                                </button>
                              )}
                              {p.socketId !== hostId && (
                                <button className="btn btn-outline" style={{ padding: '0.2rem', color: 'var(--danger)' }} onClick={() => kickPlayer(p.socketId)}>
                                  <UserMinus size={16} />
                                </button>
                              )}
                            </td>
                          )}
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

                        <div className="input-group" style={{ flexDirection: 'row', alignItems: 'center', marginTop: '1rem' }}>
                          <input type="checkbox" id="randomOrder" checked={randomOrder ?? true} onChange={(e) => setRandomOrder(e.target.checked)} style={{ width: 'auto', marginRight: '0.5rem' }} />
                          <label htmlFor="randomOrder" style={{ marginBottom: 0 }}>Random Order</label>
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
