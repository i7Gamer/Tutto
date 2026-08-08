/**
 * Shared setup for the e2e specs. Not a spec itself — playwright only collects
 * *.spec.js from this directory, so this file is only ever imported.
 */

/**
 * Cards that always play an ordinary turn: draw one and the player rolls.
 *
 * The alternative is what makes this necessary. A Stop card ends the turn the
 * moment it is drawn, with no dice and no Roll Dice button, and the default
 * deck holds 10 of them in 56 — so any test that rolls dice fails about one
 * run in six, for a reason that has nothing to do with what it is testing.
 */
export const ROLLING_DECK = { '200': 5, '300': 5, '400': 5, '500': 5, '600': 5 };

/**
 * Fixes the deck a local game is played with, before the app boots.
 *
 * Call before the first navigation: init() reads this key at start-up and
 * keeps only the fields it recognises (see pickLocalGameState in
 * src/store/persistence.ts), so seeding the deck leaves the rest of the saved
 * state — players, config, an interrupted game — exactly as it was.
 */
export const seedLocalDeck = (page, deck = ROLLING_DECK) =>
  page.addInitScript(initialCards => {
    localStorage.setItem('tutto_local_game', JSON.stringify({ initialCards }));
  }, deck);
