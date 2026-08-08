import type { CardType } from '../types';
import { BONUS_CARDS } from './configValidation';

export const rollDie = (): number => Math.floor(Math.random() * 6) + 1;

export const isBust = (rolledVals: number[], card: CardType | null, kniffelProgress: number[]): boolean => {
  if (card === 'Kniffel') {
    let nextNeeded: number[];
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

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  rolledVals.forEach(v => { counts[v]++; });
  for (let i = 2; i <= 6; i++) {
    if (counts[i] >= 3) return false;
  }
  return true;
};

export const checkKniffel = (
  vals: number[],
  progress: number[],
): { valid: boolean; newProgress: number[] } => {
  if (vals.length === 0) return { valid: false, newProgress: progress };
  const sorted = [...vals].sort((a, b) => a - b);

  let p = [...progress];

  if (p.length === 0) {
    if (sorted[0] === 1) {
      const temp: number[] = [];
      let current = 1;
      let ok = true;
      for (const v of sorted) {
        if (v === current) { temp.push(v); current++; }
        else { ok = false; break; }
      }
      if (ok) return { valid: true, newProgress: temp };
    }
    const sortedDesc = [...vals].sort((a, b) => b - a);
    if (sortedDesc[0] === 6) {
      const temp: number[] = [];
      let current = 6;
      let ok = true;
      for (const v of sortedDesc) {
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
    for (const v of sorted) {
      if (v === current) { p.push(v); current++; }
      else { ok = false; break; }
    }
    if (ok) return { valid: true, newProgress: p };
  } else {
    const sortedDesc = [...vals].sort((a, b) => b - a);
    let current = p[p.length - 1] - 1;
    let ok = true;
    for (const v of sortedDesc) {
      if (v === current) { p.push(v); current--; }
      else { ok = false; break; }
    }
    if (ok) return { valid: true, newProgress: p };
  }

  return { valid: false, newProgress: progress };
};

export const checkValidityAndScore = (
  vals: number[],
  card: CardType | null,
  kniffelProgress: number[],
): { valid: boolean; score: number; newKniffelProgress: number[] } => {
  if (vals.length === 0) return { valid: false, score: 0, newKniffelProgress: kniffelProgress };

  if (card === 'Kniffel') {
    const kRes = checkKniffel(vals, kniffelProgress);
    return { valid: kRes.valid, score: 0, newKniffelProgress: kRes.newProgress };
  }

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  vals.forEach(v => { counts[v]++; });

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
};

const collectKniffelRun = (rollVals: number[], startVal: number, step: number): number[] => {
  const picked: number[] = [];
  let needed = startVal;
  while (needed >= 1 && needed <= 6) {
    const idx = rollVals.findIndex(v => v === needed);
    if (idx === -1) break;
    picked.push(idx);
    needed += step;
  }
  return picked;
};

export const getMaxValidSelection = (
  rollVals: number[],
  card: CardType | null,
  kniffelProgress: number[] = [],
): number[] => {
  if (card === 'Kniffel') {
    if (kniffelProgress.length === 0) {
      const ascending = collectKniffelRun(rollVals, 1, 1);
      const descending = collectKniffelRun(rollVals, 6, -1);
      return ascending.length >= descending.length ? ascending : descending;
    }
    const last = kniffelProgress[kniffelProgress.length - 1];
    return kniffelProgress[0] === 1
      ? collectKniffelRun(rollVals, last + 1, 1)
      : collectKniffelRun(rollVals, last - 1, -1);
  }

  const byValue: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  rollVals.forEach((v, i) => { byValue[v].push(i); });

  const indices: number[] = [];
  indices.push(...byValue[1], ...byValue[5]);
  for (const v of [2, 3, 4, 6]) {
    const take = Math.floor(byValue[v].length / 3) * 3;
    indices.push(...byValue[v].slice(0, take));
  }
  return indices;
};

export const applyTuttoBonus = (scoreSoFar: number, currentCard: CardType | null): number => {
  let newScore = scoreSoFar;
  if (currentCard !== null && BONUS_CARDS.includes(currentCard)) {
    newScore += parseInt(currentCard, 10);
  } else if (currentCard === 'x2') {
    newScore = newScore === 0 ? 0 : newScore * 2;
  }
  return newScore;
};
