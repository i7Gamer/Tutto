// Persistence helpers for an in-progress dice turn.
//
// The turn snapshot is written to localStorage by the game store (see
// useGameStore.setLiveTurnState) and restored by DiceGame on mount. These pure
// helpers own the shape/defaults of that snapshot so the contract is testable
// in isolation, independent of React state wiring.

// Parse a raw localStorage value into a normalized restore object, or return
// null when there is nothing usable (empty or corrupted JSON). All fields are
// defaulted so callers can consume them without further guarding.
export const parseSavedDiceState = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      turnScore: parsed.turnScore || 0,
      keptDice: parsed.keptDice || [],
      currentRoll: parsed.currentRoll || [],
      kniffelProgress: parsed.kniffelProgress || [],
      tuttosThisTurn: parsed.tuttosThisTurn || 0,
      busted: !!parsed.busted,
    };
  } catch {
    return null;
  }
};

// Build the snapshot broadcast to observers / persisted for resume. When
// `busted` is true the dice are reported deselected and a `busted` flag is set;
// otherwise the in-flight `rollingDiceIds` are included so observers can mirror
// the tumble animation.
export const buildDiceSnapshot = ({
  turnScore,
  keptDice,
  currentRoll,
  kniffelProgress,
  tuttosThisTurn,
  rollingDiceIndices,
  busted = false,
}) => {
  const snapshot = {
    turnScore,
    keptDice: keptDice.map(d => ({ id: d.id, val: d.val })),
    currentRoll: currentRoll.map(d => ({ id: d.id, val: d.val, selected: busted ? false : d.selected })),
    kniffelProgress,
    tuttosThisTurn,
  };
  if (busted) {
    snapshot.busted = true;
  } else {
    snapshot.rollingDiceIds = Array.from(rollingDiceIndices ?? []);
  }
  return snapshot;
};
