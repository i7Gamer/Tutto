import React, { useState, useEffect, useMemo } from 'react';
import { Dices, Check, X, Hand, RotateCw, Play } from 'lucide-react';
import { playBuzzer, playSuccess } from '../utils/soundEffects';
import confetti from 'canvas-confetti';

const rollDie = () => Math.floor(Math.random() * 6) + 1;

const isBust = (rolledVals, card, kniffelProgress) => {
  if (card === "Kniffel") {
    let nextNeeded = [];
    if (kniffelProgress.length === 0) {
      nextNeeded = [1, 6];
    } else if (kniffelProgress[0] === 1) {
      nextNeeded = [kniffelProgress[kniffelProgress.length - 1] + 1];
    } else {
      nextNeeded = [kniffelProgress[kniffelProgress.length - 1] - 1];
    }
    return !rolledVals.some(v => nextNeeded.includes(v));
  }
  
  if (rolledVals.includes(1) || rolledVals.includes(5)) return false;
  
  const counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
  rolledVals.forEach(v => counts[v]++);
  for (let i = 2; i <= 6; i++) {
    if (counts[i] >= 3) return false;
  }
  return true;
};

const checkKniffel = (vals, progress) => {
  if (vals.length === 0) return { valid: false, newProgress: progress };
  let sorted = [...vals].sort((a,b)=>a-b);
  
  let p = [...progress];
  
  if (p.length === 0) {
    if (sorted[0] === 1) {
      let temp = [];
      let current = 1;
      let ok = true;
      for (let v of sorted) {
        if (v === current) { temp.push(v); current++; }
        else { ok = false; break; }
      }
      if (ok) return { valid: true, newProgress: temp };
    }
    let sortedDesc = [...vals].sort((a,b)=>b-a);
    if (sortedDesc[0] === 6) {
      let temp = [];
      let current = 6;
      let ok = true;
      for (let v of sortedDesc) {
        if (v === current) { temp.push(v); current--; }
        else { ok = false; break; }
      }
      if (ok) return { valid: true, newProgress: temp };
    }
    return { valid: false, newProgress: progress };
  }
  
  if (p[0] === 1) {
    let current = p[p.length - 1] + 1;
    let ok = true;
    for (let v of sorted) {
      if (v === current) { p.push(v); current++; }
      else { ok = false; break; }
    }
    if (ok) return { valid: true, newProgress: p };
  } else {
    let sortedDesc = [...vals].sort((a,b)=>b-a);
    let current = p[p.length - 1] - 1;
    let ok = true;
    for (let v of sortedDesc) {
      if (v === current) { p.push(v); current--; }
      else { ok = false; break; }
    }
    if (ok) return { valid: true, newProgress: p };
  }
  
  return { valid: false, newProgress: progress };
};

const checkValidityAndScore = (vals, card, kniffelProgress) => {
  if (vals.length === 0) return { valid: false, score: 0, newKniffelProgress: kniffelProgress };
  
  if (card === "Kniffel") {
    const kRes = checkKniffel(vals, kniffelProgress);
    return { valid: kRes.valid, score: 0, newKniffelProgress: kRes.newProgress };
  } else {
    const counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
    vals.forEach(v => counts[v]++);
    
    let score = 0;
    for (let i = 2; i <= 6; i++) {
      if (i === 5) continue;
      if (counts[i] > 0 && counts[i] < 3) return { valid: false, score: 0, newKniffelProgress: [] };
      if (counts[i] >= 3) {
        score += Math.floor(counts[i] / 3) * (i * 100);
        if (counts[i] % 3 !== 0) return { valid: false, score: 0, newKniffelProgress: [] };
      }
    }
    
    score += Math.floor(counts[1] / 3) * 1000 + (counts[1] % 3) * 100;
    score += Math.floor(counts[5] / 3) * 500 + (counts[5] % 3) * 50;
    
    return { valid: true, score, newKniffelProgress: [] };
  }
};

export default function DiceGame({ currentCard, onComplete, onCancel }) {
  const [keptDice, setKeptDice] = useState([]);
  const [currentRoll, setCurrentRoll] = useState([]);
  const [turnScore, setTurnScore] = useState(0);
  const [kniffelProgress, setKniffelProgress] = useState([]);
  
  const [hasRolled, setHasRolled] = useState(false);
  const [bustState, setBustState] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryData, setSummaryData] = useState({ won: false, score: 0, isTutto: false });
  
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
          setSummaryData({ won: true, score: currentTurnScore, isTutto: false });
        } else {
          setSummaryData({ won: false, score: 0, isTutto: false });
        }
        setShowSummary(true);
      }, 1500);
    }
  };

  const applyTuttoBonus = (scoreSoFar) => {
    let newScore = scoreSoFar;
    if (["200", "300", "400", "500", "600"].includes(currentCard)) {
      newScore += parseInt(currentCard);
    } else if (currentCard === "x2") {
      newScore = newScore === 0 ? 0 : newScore * 2;
    }
    return newScore;
  };

  const handleAction = (action) => {
    if (!validation.valid && action !== 'stop') return;
    
    let newTurnScore = turnScore + validation.score;
    let newKniffelProgress = validation.newKniffelProgress;
    let newKeptDice = [...keptDice, ...selectedRolls];
    
    const isTutto = newKeptDice.length === 6;
    
    if (isTutto) {
      newTurnScore = applyTuttoBonus(newTurnScore);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSuccess();
      
      if (currentCard !== "Feuerwerk") {
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

  const isMakingTutto = keptDice.length + selectedRolls.length === 6;
  const isSpecialCard = ["Kniffel", "Plus_Minus", "Kleeblatt"].includes(currentCard);
  
  const canStop = hasRolled && !bustState && validation.valid && currentCard !== "Feuerwerk" &&
    (isMakingTutto || !isSpecialCard);

  const isRollAgainApplicable = !(isMakingTutto && currentCard !== "Feuerwerk");
  const stopButtonText = (isMakingTutto && isSpecialCard) ? "Finish Card" : "Stop & Score";

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
