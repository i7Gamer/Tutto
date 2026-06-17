import React, { useState } from 'react';
import { UserPlus, Trash2, Settings, Play } from 'lucide-react';

export default function Home({ game }) {
  const { players, addPlayer, removePlayer, startGame, winningScore, setWinningScore, initialCards, setInitialCards } = game;
  const [newPlayerName, setNewPlayerName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleAddPlayer = () => {
    if (newPlayerName.trim() === "") return;
    addPlayer(newPlayerName.trim());
    setNewPlayerName("");
  };

  const updateCardCount = (card, count) => {
    setInitialCards(prev => ({ ...prev, [card]: parseInt(count) || 0 }));
  };

  return (
    <div className="container">
      <div className="glass-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1>Tutto</h1>
        
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

          {players.length > 0 && (
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
              {Object.keys(initialCards).map(card => (
                <div className="input-group" key={card}>
                  <label>{card.replace("_", "/")}</label>
                  <input type="number" value={initialCards[card]} onChange={(e) => updateCardCount(card, e.target.value)} />
                </div>
              ))}
            </div>
          </div>
        )}

        {players.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button className="btn btn-success" style={{ width: '100%', fontSize: '1.25rem', padding: '1rem' }} onClick={startGame}>
              <Play size={24} /> Start Game!
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
