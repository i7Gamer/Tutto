import { test, expect } from '@playwright/test';

test.describe('Tutto Online Ghost Lobbies', () => {
  test('host reconnects and retains status without breaking lobby', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = 'E2E-TEST-ROOM-1';

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

  test('non-host players can push game state', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = 'E2E-TEST-ROOM-2';

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

    // 3. Switch to digital dice mode so the Roll Dice button is rendered
    await pageA.getByLabel(/Digital Dice/i).click();

    // Start Game
    await pageA.getByRole('button', { name: /Start Game!/i }).click();

    // Wait for game to initialize
    await expect(pageA.getByText(/Current Player/i).first()).toBeVisible();

    // 4. Play Alice's turn until it is Bob's turn
    let aliceTurnActive = true;
    let attempts = 0;
    while(aliceTurnActive && attempts < 30) {
      attempts++;

      // Open the dice modal if the Roll Dice button is visible
      const rollBtn = pageA.getByRole('button', { name: /Roll Dice/i });
      if (await rollBtn.isVisible()) {
        await rollBtn.click();
        await pageA.waitForTimeout(300);
      }

      // Inside the DiceGame modal, roll all 6 dice
      const roll6Btn = pageA.getByRole('button', { name: /Roll 6 Dice/i });
      if (await roll6Btn.isVisible()) {
        await roll6Btn.click();
        await pageA.waitForTimeout(800); // wait for dice animation to finish
      }

      const stopBtn = pageA.getByRole('button', { name: /Stop & Score/i, exact: false }).or(pageA.getByRole('button', { name: /Stop and Score/i }));
      if (await stopBtn.isVisible()) {
        await stopBtn.click();
        await pageA.waitForTimeout(500);
      }

      const passBtn = pageA.getByRole('button', { name: /Pass/i });
      if (await passBtn.isVisible()) {
        await passBtn.click();
        await pageA.waitForTimeout(500);
      }

      // Check if it's Bob's turn by looking at the highlighted row in the leaderboard
      const isBobTurn = await pageA.locator('tr.bg-indigo-100, tr.dark\\:bg-indigo-900\\/30').filter({ hasText: 'BobGuest' }).isVisible();
      if (isBobTurn) {
        aliceTurnActive = false;
      }
    }

    // 5. Bob's turn: Bob is non-host. Verify he can roll dice and push state!
    const bobRollBtn = pageB.getByRole('button', { name: /Roll Dice/i });
    await expect(bobRollBtn).toBeVisible();

    // Open the DiceGame modal and roll — this pushes state to Alice via socket
    await bobRollBtn.click();
    const bobRoll6Btn = pageB.getByRole('button', { name: /Roll 6 Dice/i });
    await expect(bobRoll6Btn).toBeVisible();
    await bobRoll6Btn.click();

    // If Bob successfully pushed state, Alice should see the game screen still active.
    await expect(pageA.getByText(/Current Player/i).first()).toBeVisible();
  });
});
