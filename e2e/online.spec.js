import { test, expect } from '@playwright/test';

// Every browser project (chromium/firefox/webkit) runs against the SAME
// spawned server, and a room's player names stay reserved for the whole
// reconnect timeout after a context closes — so a fixed room id makes the
// second browser's join collide with the first browser's ghost players.
// Unique ids per project/worker/run keep the tests isolated.
const uniqueRoomId = (label, testInfo) =>
  `E2E-${label}-${testInfo.project.name}-w${testInfo.workerIndex}-${Date.now()}`;

test.describe('Tutto Online Ghost Lobbies', () => {
  test('host reconnects and retains status without breaking lobby', async ({ browser }, testInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('ROOM1', testInfo);

    // 1. Host creates room
    await pageA.goto('/');
    await pageA.getByRole('button', { name: /Online Play/i }).click();
    await pageA.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageA.getByPlaceholder('e.g. Alice').fill('AliceHost');
    await pageA.getByRole('button', { name: /Join \/ Create/i }).click();
    
    // Check if there is an error message
    const errorMsg = pageA.locator('.text-red-500');
    if (await errorMsg.isVisible()) {
      console.log('Error Message on Join:', await errorMsg.textContent());
    }

    // Verify room joined
    await expect(pageA.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });
    await expect(pageA.getByText(/Room: /i)).toBeVisible({ timeout: 15000 });
    
    // 2. Guest joins room
    await pageB.goto('/');
    await pageB.getByRole('button', { name: /Online Play/i }).click();
    await pageB.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageB.getByPlaceholder('e.g. Alice').fill('BobGuest');
    await pageB.getByRole('button', { name: /Join \/ Create/i }).click();
    
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
    await pageA.goto('/');
    await pageA.getByRole('button', { name: /Online Play/i }).click();
    await pageA.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageA.getByPlaceholder('e.g. Alice').fill('AliceHost');
    await pageA.getByRole('button', { name: /Join \/ Create/i }).click();

    // 2. Guest joins room
    await pageB.goto('/');
    await pageB.getByRole('button', { name: /Online Play/i }).click();
    await pageB.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageB.getByPlaceholder('e.g. Alice').fill('BobGuest');
    await pageB.getByRole('button', { name: /Join \/ Create/i }).click();

    await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

    // 3. Switch to digital dice mode so the Roll Dice button is rendered.
    // diceMode is a per-client localStorage preference, never sent through
    // pushState, so each page must toggle it independently — Alice's choice
    // has no effect on Bob's client.
    await pageA.getByLabel(/Digital Dice/i).click();
    await pageB.getByLabel(/Digital Dice/i).click();

    // 4. Make the game deterministic via the host's advanced options:
    //    - a 10s turn timer, so if Alice is drawn as the first player her idle
    //      turn expires server-side and play reaches Bob without simulating a
    //      full dice turn for her;
    //    - a bonus-cards-only deck (all special cards at 0), so no Stop card
    //      can swallow Bob's turn and no Feuerwerk/Kleeblatt multiplier can
    //      stretch the 10s window.
    await pageA.getByRole('button', { name: /Show Advanced Options/i }).click();
    const turnTimerInput = pageA.getByLabel(/Turn Timer/i);
    await turnTimerInput.fill('10');
    await turnTimerInput.press('Enter');
    for (const card of ['Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus/Minus', 'x2']) {
      const cardInput = pageA.getByLabel(card, { exact: true });
      await cardInput.fill('0');
      await cardInput.press('Enter');
    }

    // Start Game
    await pageA.getByRole('button', { name: /Start Game!/i }).click();
    await expect(pageA.getByText(/Current Player/i).first()).toBeVisible();

    // 5. Wait until it is Bob's turn — his own Roll Dice button is the
    //    authoritative signal. Turn order is random: either Bob is first
    //    (immediate), or Alice is and the server's 10s timer forces her turn
    //    over. 20s covers both with slack.
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

test.describe('Online lobby ruleset', () => {
  test('the host picks the rules; the guest gets a read-only badge that follows', async ({ browser }, testInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = uniqueRoomId('RULES', testInfo);

    // Host creates the room and sees the editable selector.
    await pageA.goto('/');
    await pageA.getByRole('button', { name: /Online Play/i }).click();
    await pageA.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageA.getByPlaceholder('e.g. Alice').fill('AliceHost');
    await pageA.getByRole('button', { name: /Join \/ Create/i }).click();
    await expect(pageA.getByText(/Room: /i)).toBeVisible({ timeout: 15000 });
    await expect(pageA.getByLabel('Modernized', { exact: true })).toBeChecked();

    // The guest joins and gets the always-visible read-only badge instead of
    // the radios — the rules are the host's call.
    await pageB.goto('/');
    await pageB.getByRole('button', { name: /Online Play/i }).click();
    await pageB.getByPlaceholder('e.g. 1234').fill(roomId);
    await pageB.getByPlaceholder('e.g. Alice').fill('BobGuest');
    await pageB.getByRole('button', { name: /Join \/ Create/i }).click();
    await expect(pageB.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });

    await expect(pageB.getByText(/Rules: Modernized \(set by host\)/)).toBeVisible();
    await expect(pageB.getByLabel('Modernized', { exact: true })).toHaveCount(0);

    // A host flip must reach the guest's badge through the config sync.
    await pageA.getByLabel('Classic', { exact: true }).click();
    await expect(pageB.getByText(/Rules: Classic \(set by host\)/)).toBeVisible({ timeout: 10000 });
  });
});
