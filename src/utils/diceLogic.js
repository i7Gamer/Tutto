export const rollDie = () => Math.floor(Math.random() * 6) + 1;

export const isBust = (rolledVals, card, kniffelProgress) => {
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

export const checkKniffel = (vals, progress) => {
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

export const checkValidityAndScore = (vals, card, kniffelProgress) => {
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

export const applyTuttoBonus = (scoreSoFar, currentCard) => {
  let newScore = scoreSoFar;
  if (["200", "300", "400", "500", "600"].includes(currentCard)) {
    newScore += parseInt(currentCard);
  } else if (currentCard === "x2") {
    newScore = newScore === 0 ? 0 : newScore * 2;
  }
  return newScore;
};
