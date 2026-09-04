/**
 * Shared setup for the e2e specs. Not a spec itself — playwright only collects
 * *.spec.ts from this directory, so this file is only ever imported.
 */
import { expect, type Page } from '@playwright/test';

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
export const seedLocalDeck = (page: Page, deck: Record<string, number> = ROLLING_DECK) =>
  page.addInitScript(initialCards => {
    localStorage.setItem('tutto_local_game', JSON.stringify({ initialCards }));
  }, deck);

/** Two players is the smallest game that takes turns. */
export const DEFAULT_PLAYERS = ['Alice', 'Bob'];

/**
 * Creates or joins an online room from a fresh page: the Online Play flow up
 * to and including the Join / Create click. Every online spec drove this by
 * hand, twice per test — one helper keeps the copies from drifting apart.
 * Waiting for the join to land stays with the caller: each test has its own
 * idea of what "joined" means (a name, the room banner, an error).
 */
export const joinOnlineRoom = async (page: Page, roomId: string, name: string) => {
  await openOnlineJoinForm(page);
  await submitOnlineJoin(page, roomId, name);
};

/** The half of joinOnlineRoom that needs no room yet: load the app, open Online Play. */
export const openOnlineJoinForm = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Online Play/i }).click();
};

/** The other half: fill the form the previous step opened and submit it. */
export const submitOnlineJoin = async (page: Page, roomId: string, name: string) => {
  await page.getByPlaceholder('e.g. 1234').fill(roomId);
  await page.getByPlaceholder('e.g. Alice').fill(name);
  await page.getByRole('button', { name: /Join \/ Create/i }).click();
};

/**
 * A host and a guest into one room, from two fresh pages.
 *
 * The two page loads and Online Play clicks run side by side: neither needs
 * the room to exist. Only the two submits are ordered — Join / Create makes
 * whoever arrives first the host, so the guest's is held until the host's
 * room banner is on screen. Every two-context test used to do all of this
 * strictly in sequence, which on the slowest engine was most of the test's
 * time budget before a single assertion ran.
 *
 * Waiting for the guest to LAND stays with the caller, as with joinOnlineRoom:
 * each test has its own idea of what "joined" means.
 */
export const joinOnlineRoomPair = async (
  host: { page: Page; name: string },
  guest: { page: Page; name: string },
  roomId: string,
) => {
  await Promise.all([openOnlineJoinForm(host.page), openOnlineJoinForm(guest.page)]);
  await submitOnlineJoin(host.page, roomId, host.name);
  await expect(host.page.getByText(/Room: /i)).toBeVisible({ timeout: JOIN_LANDED_TIMEOUT_MS });
  await submitOnlineJoin(guest.page, roomId, guest.name);
};

/**
 * How long a join may take to show on screen: a socket round trip plus a
 * render, on an engine that may be sharing the machine with another worker.
 * The same figure the two-context tests already used for their own waits.
 */
export const JOIN_LANDED_TIMEOUT_MS = 15000;

/**
 * Takes an already-loaded lobby to a game in progress: adds the players and
 * starts, waiting for each name to appear rather than typing the next one
 * over it.
 *
 * For specs that need a game to be underway. The lobby flow itself is a
 * subject in its own right, and game.spec.ts still walks it step by step —
 * that test is about what the player sees on the way, not about arriving.
 */
export const startLocalGame = async (page: Page, names: string[] = DEFAULT_PLAYERS) => {
  const playerInput = page.getByPlaceholder(/Player name/i);
  for (const name of names) {
    await playerInput.fill(name);
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: /Start Game!/i }).click();
  await expect(page.getByText(/Current Player/i)).toBeVisible();
};
