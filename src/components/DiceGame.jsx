import React, { useState, useEffect, useMemo } from 'react';
import { Dices, Check, X, Hand, RotateCw, Play } from 'lucide-react';
import { playBuzzer, playSuccess } from '../utils/soundEffects';
import confetti from 'canvas-confetti';
import { rollDie, isBust, checkValidityAndScore, applyTuttoBonus } from '../utils/diceLogic';

export default function DiceGame({ currentCard, onComplete, onCancel }) {
  const [keptDice, setKeptDice] = useState([]);
  const [currentRoll, setCurrentRoll] = useState([]);
  const [turnScore, setTurnScore] = useState(0);
  const [kniffelProgress, setKniffelProgress] = useState([]);
  
  const [hasRolled, setHasRolled] = useState(false);
  const [bustState, setBustState] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryData, setSummaryData] = useState({ won: false, score: 0, isTutto: false });
  const [tuttosThisTurn, setTuttosThisTurn] = useState(0);
  
  const selectedRolls = currentRoll.filter(d => d.selected);
  const selectedVals = selectedRolls.map(d => d.val);
  
  const validation = useMemo(() => checkValidityAndScore(selectedVals, currentCard, kniffelProgress), [selectedVals, currentCard, kniffelProgress]);
  
  const activeCount = 6 - keptDice.length;
  
  const roll = (countToRoll, currentKniffelProgress = kniffelProgress, currentTurnScore = turnScore) => {
    const newRoll = Array.from({length: countToRoll}, (_, i) => ({
      id: Date.now() + i,
      val: rollDie(),
      selected: false
    }));
    
    setCurrentRoll(newRoll);
    setHasRolled(true);
    
    if (isBust(newRoll.map(d => d.val), currentCard, currentKniffelProgress)) {
      setBustState(true);
      playBuzzer();
      
      setTimeout(() => {
        if (currentCard === "Feuerwerk") {
          setSummaryData({ won: currentTurnScore > 0, score: currentTurnScore, isTutto: false });
        } else {
          setSummaryData({ won: false, score: 0, isTutto: false });
        }
        setShowSummary(true);
      }, 1500);
    }
  };

  const handleAction = (action) => {
    if (!validation.valid && action !== 'stop') return;
    
    let newTurnScore = turnScore + validation.score;
    let newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];
    
    const isTutto = newKeptDice.length === 6;
    
    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore, currentCard);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();
      
      if (currentCard === "Kleeblatt") {
        if (tuttosThisTurn === 0) {
          setTuttosThisTurn(1);
          setKeptDice([]);
          setTurnScore(newTurnScore);
          setKniffelProgress(newKniffelProgress);
          roll(6, newKniffelProgress, newTurnScore);
          return;
        } else {
          setSummaryData({ won: true, score: newTurnScore, isTutto: true });
          setShowSummary(true);
          return;
        }
      } else if (currentCard !== "Feuerwerk") {
        setSummaryData({ won: true, score: newTurnScore, isTutto: true });
        setShowSummary(true);
        return;
      }
    }
    
    if (action === 'stop') {
      setSummaryData({ won: true, score: newTurnScore, isTutto });
      setShowSummary(true);
      return;
    }
    
    if (action === 'roll') {
      setTurnScore(newTurnScore);
      setKniffelProgress(newKniffelProgress);
      
      if (isTutto) {
        setKeptDice([]);
        roll(6, newKniffelProgress, newTurnScore);
      } else {
        setKeptDice(newKeptDice);
        roll(6 - newKeptDice.length, newKniffelProgress, newTurnScore);
      }
    }
  };

  const toggleDie = (id) => {
    if (bustState || showSummary) return;
    setCurrentRoll(prev => prev.map(d => d.id === id ? { ...d, selected: !d.selected } : d));
  };

  const finishGame = () => {
    if (summaryData.won) {
      onComplete(summaryData.score, true);
    } else {
      onComplete(0, false);
    }
  };

  useEffect(() => {
    let timeout;
    if (showSummary && bustState) {
      timeout = setTimeout(() => {
        finishGame();
      }, 1500); // 1.5s after summary is shown (which is 1.5s after bust = 3s total)
    }
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSummary, bustState]);

  const isMakingTutto = keptDice.length + selectedRolls.length === 6;
  const isSpecialCard = ["Kniffel", "Plus_Minus", "Kleeblatt"].includes(currentCard);
  
  const canStop = hasRolled && !bustState && validation.valid && currentCard !== "Feuerwerk" &&
    (isMakingTutto || !isSpecialCard);

  const isRollAgainApplicable = !(isMakingTutto && currentCard !== "Feuerwerk");
  
  let stopButtonText = "Stop & Score";
  if (isMakingTutto && isSpecialCard) {
    if (currentCard === "Kleeblatt" && tuttosThisTurn === 0) {
      stopButtonText = "Roll 2nd Tutto";
    } else {
      stopButtonText = "Finish Card";
    }
  }

  let displayKeptDice = [...keptDice];
  if (currentCard === "Kniffel" && kniffelProgress.length > 0) {
    if (kniffelProgress[0] === 1) {
      displayKeptDice.sort((a, b) => a.val - b.val);
    } else {
      displayKeptDice.sort((a, b) => b.val - a.val);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content" style={{ maxWidth: '500px', width: '90%', padding: '2rem' }}>
        
        {!showSummary && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h2 style={{ margin: 0 }}>Dice Game</h2>
            {!hasRolled && <button className="btn btn-outline" style={{ padding: '0.5rem', color: 'var(--danger)' }} onClick={onCancel}><X size={20}/></button>}
          </div>
        )}

        {showSummary ? (
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ color: summaryData.won ? 'var(--success)' : 'var(--danger)' }}>
              {summaryData.won ? "Success!" : "Bust!"}
            </h2>
            {summaryData.isTutto && <h3 style={{ color: 'var(--primary)' }}>Tutto!</h3>}
            {summaryData.won && !["Kniffel", "Plus_Minus", "Kleeblatt"].includes(currentCard) && (
              <p style={{ fontSize: '1.5rem' }}>Points gained: <strong>{summaryData.score}</strong></p>
            )}
            
            <button className="btn btn-primary" style={{ marginTop: '2rem', width: '100%', padding: '1rem' }} onClick={finishGame}>
              Continue to Next Player <Check size={20} style={{ marginLeft: 8 }} />
            </button>
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '1.25rem', color: 'var(--text-color)', opacity: 0.8 }}>Current Score</div>
              <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>
                {turnScore + (validation.valid ? validation.score : 0)}
              </div>
              {currentCard === "Kleeblatt" && (
                <div style={{ fontSize: '1rem', color: 'var(--success)', marginTop: '0.5rem', fontWeight: 'bold' }}>
                  Tuttos: {tuttosThisTurn} / 2
                </div>
              )}
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <h4 style={{ marginBottom: '0.5rem' }}>Kept Dice</h4>
              <div className="dice-container" style={{ minHeight: '60px', padding: '10px', background: 'rgba(0,0,0,0.1)', borderRadius: '8px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {displayKeptDice.map((d, i) => (
                  <div key={`kept-${i}`} className="die kept">
                    {d.val}
                  </div>
                ))}
                {displayKeptDice.length === 0 && <span style={{ opacity: 0.5 }}>None</span>}
              </div>
            </div>

            <div style={{ marginBottom: '2rem' }}>
              <h4 style={{ marginBottom: '0.5rem' }}>Current Roll</h4>
              {!hasRolled ? (
                <div style={{ padding: '2rem', textAlign: 'center' }}>
                  <button className="btn btn-primary" style={{ padding: '1rem 2rem', fontSize: '1.25rem' }} onClick={() => roll(6)}>
                    <Dices size={24} style={{ marginRight: 8 }} /> Roll 6 Dice
                  </button>
                </div>
              ) : (
                <>
                  <div className="dice-container" style={{ minHeight: '60px', padding: '10px', borderRadius: '8px', display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
                    {currentRoll.map(d => (
                      <div 
                        key={d.id} 
                        className={`die ${d.selected ? 'selected' : ''} ${bustState ? 'bust' : ''}`}
                        onClick={() => toggleDie(d.id)}
                      >
                        {d.val}
                      </div>
                    ))}
                  </div>
                  
                  {bustState && (
                    <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: '1.5rem', fontWeight: 'bold', marginTop: '1rem' }}>
                      Bust! (Volltreffer/Niete)
                    </div>
                  )}
                  
                  {!bustState && (
                    <div style={{ textAlign: 'center', marginTop: '0.5rem', minHeight: '24px' }}>
                      {!validation.valid && selectedRolls.length > 0 && (
                        <span style={{ color: 'var(--danger)' }}>Invalid selection</span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {hasRolled && !bustState && (
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                {canStop && (
                  <button className="btn btn-success" disabled={!validation.valid} onClick={() => handleAction('stop')} style={{ flex: 1 }}>
                    <Hand size={18} style={{ marginRight: 8 }} /> {stopButtonText}
                  </button>
                )}
                
                {isRollAgainApplicable && (
                  <button className="btn btn-primary" disabled={!validation.valid} onClick={() => handleAction('roll')} style={{ flex: 1 }}>
                    <RotateCw size={18} style={{ marginRight: 8 }} /> Roll Again
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
