import React, { useState, useEffect } from 'react';
import { Undo2, ChevronRight, Check, X, Dices } from 'lucide-react';
import DiceGame from './DiceGame';
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
    cards,
    formattedTime,
    nextTurn,
    undo,
    previousCard,
    currentCardHasInput,
    currentCardHasYesNo,
    endGame,
    isOnline,
    myName,
    winningScore,
    players,
    currentPlayerIndex
  } = game;

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  const [scoreInput, setScoreInput] = useState("");
  const [applyBonus, setApplyBonus] = useState(false);
  const [animateRound, setAnimateRound] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);

  useEffect(() => {
    let timeout;
    if (isOnline && isMyTurn && currentCard === "Stop") {
      playBuzzer();
      timeout = setTimeout(() => {
        nextTurn(0, false);
      }, 5000);
    }
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, isMyTurn, currentCard]);

  useEffect(() => {
    if (round > 0) {
      setAnimateRound(true);
      const timer = setTimeout(() => setAnimateRound(false), 800);
      return () => clearTimeout(timer);
    }
  }, [round]);

  useEffect(() => {
    if (currentCard === "Feuerwerk") {
      confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
      playSuccess();
    }
  }, [currentCard, cards?.length]);

  const handleNextTurn = () => {
    let parsedScore = parseInt(scoreInput) || 0;
    
    if (applyBonus) {
      if (["200", "300", "400", "500", "600"].includes(currentCard)) {
        parsedScore += parseInt(currentCard);
      } else if (currentCard === "x2") {
        parsedScore = parsedScore === 0 ? 0 : parsedScore * 2;
      }
    }

    nextTurn(parsedScore, parsedScore > 0);
    setScoreInput("");
    setApplyBonus(false);
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

  const handleDiceComplete = (score, isSuccess) => {
    setShowDiceGame(false);
    if (currentCardHasYesNo) {
      handleYesNo(isSuccess);
    } else {
      nextTurn(score, isSuccess);
    }
  };

  const addScore = (val) => {
    setScoreInput(prev => (parseInt(prev) || 0) + val);
  };

  if (!currentPlayer) return null;

  let turnsLeft = null;
  if (isOnline && !isMyTurn && players && players.length > 0 && currentPlayerIndex !== null && currentPlayerIndex !== undefined) {
    const myIndex = players.findIndex(p => p.name === myName);
    if (myIndex !== -1) {
      turnsLeft = (myIndex - currentPlayerIndex + players.length) % players.length;
    }
  }

  const roundProgress = players?.length ? (currentPlayerIndex / players.length) * 100 : 0;
  
  const displayPlayer = isOnline ? (players?.find(p => p.name === myName) || currentPlayer) : currentPlayer;
  const displayScore = displayPlayer ? displayPlayer.score : 0;
  const scoreProgress = winningScore ? Math.min((displayScore / winningScore) * 100, 100) : 0;

  return (
    <div className="container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '5rem' }}>
      <div className="game-stats">
        <div className="stat-box" style={{ flex: 1 }}>
          <div className="label">Current Player</div>
          <div className="value" style={{ color: currentPlayer.color || 'var(--primary)' }}>
            {isOnline && isMyTurn ? `You (${currentPlayer.name})` : currentPlayer.name}
          </div>
        </div>
        <div className={`stat-box ${animateRound ? 'animate-pulse-round' : ''}`} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: `${roundProgress}%`, backgroundColor: 'var(--primary)', opacity: 0.15, zIndex: 0, transition: 'height 0.3s ease' }}></div>
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div className="label">Round</div>
            <div className="value">{round}</div>
          </div>
        </div>
        <div className="stat-box" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: `${scoreProgress}%`, backgroundColor: 'var(--success)', opacity: 0.15, zIndex: 0, transition: 'height 0.3s ease' }}></div>
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div className="label">{isOnline ? "Your Score" : "Score"}</div>
            <div className="value">{displayScore}</div>
          </div>
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
              <img key={`${currentCard}-${cards ? cards.length : 0}`} src={`./assets/${CARD_IMAGE_MAP[currentCard]}`} alt={currentCard} className="card-image" />
            ) : (
              <div style={{ padding: '2rem', color: 'var(--text-color)', opacity: 0.5 }}>No card</div>
            )}
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            {isMyTurn && currentCardHasInput && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button className="btn btn-primary" onClick={() => setShowDiceGame(true)} style={{ padding: '1rem 2rem', fontSize: '1.25rem', marginBottom: '1rem', width: '100%' }}>
                  <Dices size={24} style={{ marginRight: '8px' }} /> Roll Dice
                </button>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', margin: '1rem 0' }}>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }}></div>
                  <div style={{ padding: '0 1rem', color: 'var(--text-color)', opacity: 0.7, fontWeight: 'bold' }}>OR TYPE SCORE</div>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }}></div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                  <input 
                    type="number" 
                    value={scoreInput}
                    onChange={(e) => setScoreInput(e.target.value)}
                    placeholder="Points (if no dice used)"
                    style={{ fontSize: '1.5rem', textAlign: 'center', maxWidth: '250px' }}
                  />
                  {["200", "300", "400", "500", "600", "x2"].includes(currentCard) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', opacity: 0.9 }}>
                      <input 
                        type="checkbox" 
                        checked={applyBonus} 
                        onChange={(e) => setApplyBonus(e.target.checked)} 
                        style={{ width: 'auto' }}
                      />
                      Apply bonus
                    </label>
                  )}
                </div>
                <div className="score-buttons">
                  {[50, 100, 200, 300, 400, 500, 600, 1000].map(val => (
                    <button key={val} className="btn btn-outline" style={{ padding: '0.5rem 1rem' }} onClick={() => addScore(val)}>
                      {val}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!isMyTurn && isOnline && (
              <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                <div style={{ fontWeight: 'bold' }}>Waiting for {currentPlayer.name}...</div>
                {turnsLeft !== null && (
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-color)', opacity: 0.7, marginTop: '0.3rem', fontWeight: '500' }}>
                    {turnsLeft === 1 ? "1 turn left until it's your turn again" : `${turnsLeft} turns left until it's your turn again`}
                  </div>
                )}
              </div>
            )}

            {isMyTurn && currentCardHasYesNo && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '1.5rem 0' }}>
                <button className="btn btn-primary" onClick={() => setShowDiceGame(true)} style={{ padding: '1rem 2rem', fontSize: '1.25rem', marginBottom: '1rem', width: '100%' }}>
                  <Dices size={24} style={{ marginRight: '8px' }} /> Roll Dice
                </button>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', margin: '1rem 0' }}>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }}></div>
                  <div style={{ padding: '0 1rem', color: 'var(--text-color)', opacity: 0.7, fontWeight: 'bold' }}>OR QUICK FINISH</div>
                  <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }}></div>
                </div>
                <div className="flex-center" style={{ width: '100%', gap: '1rem' }}>
                  <button className="btn btn-success" style={{ flex: 1, padding: '1rem', fontSize: '1.25rem' }} onClick={() => handleYesNo(true)}>
                    <Check /> Yes
                  </button>
                  <button className="btn btn-danger" style={{ flex: 1, padding: '1rem', fontSize: '1.25rem' }} onClick={() => handleYesNo(false)}>
                    <X /> No
                  </button>
                </div>
              </div>
            )}

            {isMyTurn && (
              <div className="flex-center" style={{ marginTop: '2rem' }}>
                {previousCard && previousCard !== "Stop" && (
                  <button className="btn btn-secondary" onClick={undo}>
                    <Undo2 /> Undo
                  </button>
                )}
                
                {!currentCardHasYesNo && currentCardHasInput && (
                  <button className="btn btn-primary" onClick={handleNextTurn}>
                    Next Turn <ChevronRight />
                  </button>
                )}

                {!currentCardHasYesNo && !currentCardHasInput && (
                  <button className="btn btn-primary" onClick={() => nextTurn(0, false)}>
                    Continue <ChevronRight />
                  </button>
                )}
              </div>
            )}
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
                    <td style={{ fontWeight: 600, color: p.color || 'var(--text-color)' }}>
                      <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', backgroundColor: p.color || '#ffffff', verticalAlign: 'middle', marginRight: '8px' }}></span>
                      {p.name}
                    </td>
                    <td style={{ fontWeight: 600 }}>{p.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {winningScore && (
            <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.9rem', opacity: 0.8, borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
              Goal: First to reach <strong>{winningScore}</strong> points at the end of a round wins!
            </div>
          )}
        </div>
      </div>

      {(!isOnline || game.isHost) && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
          <button className="btn btn-outline" style={{ color: 'var(--danger)' }} onClick={endGame}>
            Abort Game
          </button>
        </div>
      )}

      {showDiceGame && (
        <DiceGame 
          currentCard={currentCard} 
          onComplete={handleDiceComplete} 
          onCancel={() => setShowDiceGame(false)} 
        />
      )}
    </div>
  );
}
