import React, { useState, useEffect } from 'react';
import { Undo2, ChevronRight, Check, X } from 'lucide-react';
import confetti from 'canvas-confetti';
import { playBuzzer, playSuccess } from '../utils/soundEffects';

const CARD_IMAGE_MAP = {
  "200": "200.png",
  "300": "300.png",
  "400": "400.png",
  "500": "500.png",
  "600": "600.png",
  "x2": "x2.png",
  "Feuerwerk": "Feuerwerk.png",
  "Stop": "Stop.png",
  "Kleeblatt": "Kleeblatt.png",
  "Plus_Minus": "plusminus.png",
  "Kniffel": "Kniffel.png"
};

export default function Game({ game }) {
  const { 
    currentPlayer, 
    sortedPlayers, 
    currentCard, 
    round, 
    formattedTime,
    nextTurn,
    undo,
    previousCard,
    currentCardHasInput,
    currentCardHasYesNo,
    endGame,
    isOnline,
    myName
  } = game;

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  const [scoreInput, setScoreInput] = useState("");

  useEffect(() => {
    if (currentCard === "Feuerwerk") {
      confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
      playSuccess();
    }
  }, [currentCard]);

  const handleNextTurn = () => {
    nextTurn(parseInt(scoreInput) || 0, false);
    setScoreInput("");
  };

  const handleYesNo = (isSuccess) => {
    if (isSuccess && (currentCard === "Kniffel" || currentCard === "Kleeblatt")) {
      confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
      playSuccess();
    }

    if (isSuccess && currentCard === "Plus_Minus") {
      const topScore = Math.max(...game.players.map(p => p.score));
      if (currentPlayer.score < topScore) {
        playBuzzer();
      } else {
        playSuccess();
      }
    }

    nextTurn(0, isSuccess);
    setScoreInput("");
  };

  const addScore = (val) => {
    setScoreInput(prev => (parseInt(prev) || 0) + val);
  };

  if (!currentPlayer) return null;

  return (
    <div className="container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '5rem' }}>
      <div className="game-stats">
        <div className="stat-box" style={{ flex: 1 }}>
          <div className="label">Current Player</div>
          <div className="value" style={{ color: 'var(--primary)' }}>{currentPlayer.name}</div>
        </div>
        <div className="stat-box" style={{ flex: 1 }}>
          <div className="label">Round</div>
          <div className="value">{round}</div>
        </div>
        <div className="stat-box" style={{ flex: 1 }}>
          <div className="label">Score</div>
          <div className="value">{currentPlayer.score}</div>
        </div>
        <div className="stat-box" style={{ flex: 1 }}>
          <div className="label">Playtime</div>
          <div className="value">{formattedTime}</div>
        </div>
      </div>

      <div className="grid-cols-2">
        <div className="glass-card">
          <h3 style={{ textAlign: 'center' }}>Current Card</h3>
          <div className="card-image-container">
            {currentCard ? (
              <img src={`./assets/${CARD_IMAGE_MAP[currentCard]}`} alt={currentCard} className="card-image" />
            ) : (
              <div style={{ padding: '2rem', color: 'var(--text-color)', opacity: 0.5 }}>No card</div>
            )}
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            {currentCardHasInput && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <input 
                  type="number" 
                  value={scoreInput}
                  onChange={(e) => setScoreInput(e.target.value)}
                  placeholder="Score"
                  disabled={!isMyTurn}
                  style={{ fontSize: '1.5rem', textAlign: 'center', maxWidth: '200px', marginBottom: '1rem' }}
                />
                <div className="score-buttons">
                  {[50, 100, 200, 300, 400, 500, 600, 1000].map(val => (
                    <button key={val} className="btn btn-outline" style={{ padding: '0.5rem 1rem' }} onClick={() => addScore(val)} disabled={!isMyTurn}>
                      {val}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!isMyTurn && isOnline && (
              <div style={{ textAlign: 'center', margin: '1rem 0', fontWeight: 'bold' }}>
                Waiting for {currentPlayer.name}...
              </div>
            )}

            {currentCardHasYesNo && (
              <div className="flex-center" style={{ margin: '1.5rem 0' }}>
                <button className="btn btn-success" style={{ padding: '1rem 2rem', fontSize: '1.25rem' }} onClick={() => handleYesNo(true)} disabled={!isMyTurn}>
                  <Check /> Yes
                </button>
                <button className="btn btn-danger" style={{ padding: '1rem 2rem', fontSize: '1.25rem' }} onClick={() => handleYesNo(false)} disabled={!isMyTurn}>
                  <X /> No
                </button>
              </div>
            )}

            <div className="flex-center" style={{ marginTop: '2rem' }}>
              {previousCard && previousCard !== "Stop" && (
                <button className="btn btn-secondary" onClick={undo} disabled={!isMyTurn}>
                  <Undo2 /> Undo
                </button>
              )}
              
              {!currentCardHasYesNo && currentCardHasInput && (
                <button className="btn btn-primary" onClick={handleNextTurn} disabled={!isMyTurn}>
                  Next Turn <ChevronRight />
                </button>
              )}

              {!currentCardHasYesNo && !currentCardHasInput && (
                <button className="btn btn-primary" onClick={() => nextTurn(0, false)} disabled={!isMyTurn}>
                  Continue <ChevronRight />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="glass-card">
          <h3>Leaderboard</h3>
          <div className="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Pos</th>
                  <th>Player</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {sortedPlayers.map(p => (
                  <tr key={p.name} className={p.name === currentPlayer.name ? "active-player" : ""}>
                    <td>{p.position}.</td>
                    <td>{p.name}</td>
                    <td style={{ fontWeight: 600 }}>{p.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
        <button className="btn btn-outline" style={{ color: 'var(--danger)' }} onClick={endGame} disabled={isOnline && !game.isHost}>
          Abort Game
        </button>
      </div>
    </div>
  );
}
