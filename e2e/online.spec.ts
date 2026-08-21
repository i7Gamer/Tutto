import { test, expect, type TestInfo } from '@playwright/test';
import { joinOnlineRoom } from './helpers';

// Every browser project (chromium/firefox/webkit) runs against the SAME
// spawned server, and a room's player names stay reserved for the whole
// reconnect timeout after a context closes — so a fixed room id makes the
// second browser's join collide with the first browser's ghost players.
// Unique ids per project/worker/run keep the tests isolated.
const uniqueRoomId = (label: string, testInfo: TestInfo) =>
  `E2E-${label}-${testInfo.project.name}-w${testInfo.workerIndex}-${Date.now()}`;

test.describe('Tutto Online Ghost Lobbies', () => {
  test('host reconnects and retains status without breaking lobby', async ({ browser }, testInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('ROOM1', testInfo);

    // 1. Host creates room
    await joinOnlineRoom(pageA, roomId, 'AliceHost');

    // Check if there is an error message
    const errorMsg = pageA.locator('.text-red-500');
    if (await errorMsg.isVisible()) {
      console.log('Error Message on Join:', await errorMsg.textContent());
    }

    // Verify room joined
    await expect(pageA.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });
    await expect(pageA.getByText(/Room: /i)).toBeVisible({ timeout: 15000 });

    // 2. Guest joins room
    await joinOnlineRoom(pageB, roomId, 'BobGuest');

    await expect(pageA.getByText('BobGuest').first()).toBeVisible();
    await expect(pageB.getByText('AliceHost').first()).toBeVisible();

    // 3. Host reloads page
    await pageA.reload();
    
    // Verify guest still sees host (ghost lobby fix)
    await expect(pageB.getByText('AliceHost').first()).toBeVisible();
    
    // 4. Host reconnects via session restore popup (reload triggers it from sessionStorage)
    await pageA.getByRole('button', { name: /Yes, Reconnect/i }).click();

    // 5. Verify host regains "Start Game!" button
    const startGameBtn = pageA.getByRole('button', { name: /Start Game!/i });
    await expect(startGameBtn).toBeVisible();
  });

  test('non-host players can push game state', async ({ browser }, testInfo) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('ROOM2', testInfo);

    // 1. Host creates room
    await joinOnlineRoom(pageA, roomId, 'AliceHost');

    // 2. Guest joins room
    await joinOnlineRoom(pageB, roomId, 'BobGuest');

    await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

    // 3. Switch to digital dice mode so the Roll Dice button is rendered.
    // diceMode is a per-client localStorage preference, never sent through
    // pushState, so each page must toggle it independently — Alice's choice
    // has no effect on Bob's client.
    await pageA.getByLabel(/Digital Dice/i).click();
    await pageB.getByLabel(/Digital Dice/i).click();

    // 4. Make the game deterministic via the host's lobby controls:
    //    - Bob seated FIRST, so his turn begins with the game itself. The old
    //      version left the order random and leaned on a real 10s server turn
    //      timer to force Alice's idle first turn over — a wall-clock
    //      dependency that flaked on a loaded CI worker (the 20s wait lost
    //      the race on 2026-08-21, run 32460487606).
    //    - a bonus-cards-only deck (all special cards at 0), so no Stop card
    //      can swallow Bob's turn.
    await pageA.getByRole('button', { name: /Show Advanced Options/i }).click();
    for (const card of ['Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus/Minus', 'x2']) {
      const cardInput = pageA.getByLabel(card, { exact: true });
      await cardInput.fill('0');
      await cardInput.press('Enter');
    }

    // Seat Bob first. The reorder commits after a short press-release
    // debounce, so wait for the host's roster to actually show the new order
    // — the start push then carries that ordering and the server adopts it
    // verbatim (pushValidation's startingGame branch).
    await pageA.getByRole('button', { name: 'Move up: BobGuest' }).click();
    await expect(pageA.locator('.player-name').first()).toContainText('BobGuest');
    // The determinism above RESTS on reorderPlayers flipping randomOrder off
    // (gameSlice.reorderPlayers) — if that coupling ever loosens, fail here
    // with a readable reason instead of silently going back to a coin flip.
    await expect(pageA.getByRole('switch', { name: /Random Order/i }))
      .toHaveAttribute('aria-checked', 'false');

    // Start Game
    await pageA.getByRole('button', { name: /Start Game!/i }).click();
    await expect(pageA.getByText(/Current Player/i).first()).toBeVisible();

    // 5. Bob is seated first with random order off, so his turn begins with
    //    the game itself — his own Roll Dice button is the authoritative
    //    signal, and only broadcast latency separates it from the start
    //    click. The generous timeout is slack, not a timer dependency.
    const bobRollBtn = pageB.getByRole('button', { name: /Roll Dice/i });
    await expect(bobRollBtn).toBeVisible({ timeout: 20000 });

    // 6. Bob (non-host) rolls — opening the panel auto-rolls once its entrance
    //    animation finishes (no manual "Roll 6 Dice" button anymore), and
    //    DiceGame pushes his live turn snapshot through pushState as the
    //    active player.
    await bobRollBtn.click();

    // 7. The push must round-trip through the server to Alice: her spectator
    //    view renders Bob's live turn (name + dice) only from the broadcast
    //    liveTurnState a non-host pushed.
    await expect(pageA.getByText(/BobGuest is currently playing/i)).toBeVisible({ timeout: 10000 });
  });
});

/**
 * The one browser-level test that actually PLAYS a classic turn. Everything
 * else stops at the lobby: the ruleset radio, and the guest's badge following
 * the host's choice. So gameSlice.drawCardMidTurn — the app's only mid-turn
 * deck mutation, and the reason the server restarts a turn timer without the
 * player changing — was never exercised through a real browser and a real
 * socket at all.
 *
 * With real dice the player declares their own Tutto by drawing the next card,
 * so this reaches the chain on a click rather than on a roll no test can force.
 * A digital chain needs a genuine six-dice Tutto, which nothing here can make
 * happen; the deck mutation and the push it triggers are the same either way.
 */
test.describe('Online classic chain', () => {
  // Comfortably longer than the few seconds spent below, so the draw always
  // lands inside the turn it is meant to extend, even on a slow machine.
  const TURN_TIMER_S = 30;
  // How far the countdown must have run down before the draw: a restart back up
  // is only evidence of one if the timer had visibly left where it started.
  const TICKED_DOWN_TO_S = TURN_TIMER_S - 2;
  // Zeroed for the same reason the digital test zeroes them, plus one: a drawn
  // Stop forfeits the whole classic turn instead of continuing the chain, and a
  // Feuerwerk/Kleeblatt multiplier would stretch the very timer this measures.
  const CARDS_THAT_ARE_NOT_A_PLAIN_TURN = ['Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus/Minus', 'x2'];
  // How long a single read of the timer tile may take. Scoreboard renders the
  // tile only while turnTimeRemaining != null, so if it never appears an
  // unbounded textContent() would sit on Playwright's 30s default action
  // timeout — longer than the polls below are allowed to run in total, which
  // reports the failure late and as a bare xpath timeout instead of the poll's
  // own message. Short enough that several reads still fit in a poll's budget.
  const TIMER_READ_TIMEOUT_MS = 2000;

  test('drawing the next card mid-chain restarts the turn for the spectator too', async ({ browser }, testInfo) => {
    test.setTimeout(90000);

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('CLASSIC', testInfo);

    await joinOnlineRoom(pageA, roomId, 'AliceHost');
    await joinOnlineRoom(pageB, roomId, 'BobGuest');
    await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

    // Classic rules — the host's call, and the only ruleset with a chain to
    // advance. Confirmed on the guest's badge before starting: the ruleset is
    // frozen at kickoff, so a game started before the sync landed would be a
    // modernized one wearing this test's name.
    await pageA.getByLabel('Classic', { exact: true }).click();
    await expect(pageB.getByText(/Rules: Classic \(set by host\)/)).toBeVisible({ timeout: 10000 });

    // Physical dice on both pages: diceMode is a per-client preference that
    // never travels through pushState (see the digital-dice test above). The
    // guest — seated first below — is the one who will hold the turn.
    await pageA.getByLabel(/Physical Dice/i).click();
    await pageB.getByLabel(/Physical Dice/i).click();

    await pageA.getByRole('button', { name: /Show Advanced Options/i }).click();
    const turnTimerInput = pageA.getByLabel(/Turn Timer/i);
    await turnTimerInput.fill(String(TURN_TIMER_S));
    await turnTimerInput.press('Enter');
    for (const card of CARDS_THAT_ARE_NOT_A_PLAIN_TURN) {
      const cardInput = pageA.getByLabel(card, { exact: true });
      await cardInput.fill('0');
      await cardInput.press('Enter');
    }

    // Seat Bob first — reorderPlayers switches random order off as part of
    // the same action — so the roles below are fixed instead of a coin flip
    // to re-derive after start (same deflake as the push-state test above).
    await pageA.getByRole('button', { name: 'Move up: BobGuest' }).click();
    await expect(pageA.locator('.player-name').first()).toContainText('BobGuest');

    await pageA.getByRole('button', { name: /Start Game!/i }).click();
    // BOTH pages must reach the game before anything times a countdown. The
    // 2026-08-21 flake (run 32485161908) was 20 seconds of a spectator timer
    // that never existed — indistinguishable, as written then, from a
    // spectator page still sitting in the lobby.
    await expect(pageA.getByText(/Current Player/i).first()).toBeVisible();
    await expect(pageB.getByText(/Current Player/i).first()).toBeVisible({ timeout: 15000 });

    // Fixed roles: the guest holds the turn and draws; the host spectates.
    // (A NON-host pushing the deck change is also the stronger direction of
    // this test's claim.)
    const drawButton = pageB.getByTestId('physical-draw-next-card');
    await expect(drawButton).toBeVisible({ timeout: 20000 });
    const spectatorPage = pageA;

    // The spectator's own view of the active player's turn timer: the label and
    // its value are siblings in the Scoreboard tile.
    const spectatorTimer = spectatorPage.getByText('Turn Timer', { exact: true })
      .locator('xpath=following-sibling::div[1]');
    // A missed read is reported as "no number yet" rather than thrown: a poll
    // callback that throws is not retried (expect.poll awaits it outside its
    // own try), so the throw would end the poll on the first miss instead of
    // letting it wait out the deadline it was given and fail with its message.
    const spectatorSeconds = async () => {
      try {
        return parseInt(await spectatorTimer.textContent({ timeout: TIMER_READ_TIMEOUT_MS }) ?? '', 10);
      } catch {
        return NaN; // no timer tile on screen at this instant — poll again
      }
    };

    // The tile must EXIST before its value is timed — a tile that never
    // appears (turnTimeRemaining never synced to the spectator) and a
    // countdown that never moves are different bugs, and the old NaN-for-20s
    // poll reported both with the same message.
    await expect(
      spectatorPage.getByText('Turn Timer', { exact: true }),
      "the spectator never rendered a turn-timer tile at all",
    ).toBeVisible({ timeout: 15000 });

    await expect.poll(spectatorSeconds, {
      timeout: 20000,
      message: "the spectator's turn timer never counted down",
    }).toBeLessThanOrEqual(TICKED_DOWN_TO_S);

    // The mid-chain draw. drawCardMidTurn takes a card off the deck and pushes
    // it; the shrinking deck is what tells the server a new card was drawn
    // WITHIN the turn (see socketGameStateHandlers — the card value can't, a
    // chain routinely draws the same type again), so it restarts the deadline.
    await drawButton.click();

    // What the spectator sees of a chain advancing: the countdown jumps back
    // up under the same player. Nothing else in a turn moves it backwards.
    await expect.poll(spectatorSeconds, {
      timeout: 15000,
      message: 'the mid-chain draw never reached the spectator as a restarted turn',
    }).toBeGreaterThan(TICKED_DOWN_TO_S);

    // ...and the turn did not simply pass on: the chain continued, with the
    // same player still holding it and able to draw again.
    await expect(drawButton).toBeVisible();
  });
});

test.describe('Online lobby ruleset', () => {
  test('the host picks the rules; the guest gets a read-only badge that follows', async ({ browser }, testInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('RULES', testInfo);

    // Host creates the room and sees the editable selector.
    await joinOnlineRoom(pageA, roomId, 'AliceHost');
    await expect(pageA.getByText(/Room: /i)).toBeVisible({ timeout: 15000 });
    await expect(pageA.getByLabel('Modernized', { exact: true })).toBeChecked();

    // The guest joins and gets the always-visible read-only badge instead of
    // the radios — the rules are the host's call.
    await joinOnlineRoom(pageB, roomId, 'BobGuest');
    await expect(pageB.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });

    await expect(pageB.getByText(/Rules: Modernized \(set by host\)/)).toBeVisible();
    await expect(pageB.getByLabel('Modernized', { exact: true })).toHaveCount(0);

    // A host flip must reach the guest's badge through the config sync.
    await pageA.getByLabel('Classic', { exact: true }).click();
    await expect(pageB.getByText(/Rules: Classic \(set by host\)/)).toBeVisible({ timeout: 10000 });
  });
});
