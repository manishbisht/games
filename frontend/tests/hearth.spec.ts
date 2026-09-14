import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Hearth & Home in the browser. Its rules and its pacing moved to the server
 * when bot play became a room, so a whole game played to victory is covered in
 * `shared/src/hearth/engine.test.ts` and `backend/test/room-hearth.test.ts`.
 * What is left is genuinely the browser's: the setup panel, the table it asks
 * the server for, and a turn taken elsewhere arriving here.
 *
 * Pausing is gone with local play — a room's table is nobody's to stop.
 */

const rollButton = (page: Page) => page.getByRole('button', { name: 'Roll dice', exact: true })

/** Set a table up and let the server deal it. */
async function startBotGame(page: Page, name = 'Robin') {
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/hearth-and-home\/room\/[A-Z2-9]{6}$/, { timeout: 20000 })
  // A solo table has nobody to wait for, so it deals on arrival.
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)
}

test('play vs bot deals a real table, and the server takes the bots’ turns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/hearth-and-home')
  await expect(page.getByRole('heading', { name: 'Gather around.' })).toBeVisible()
  await page.screenshot({ path: 'test-results/hearth-desktop-setup.png', fullPage: true })
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await startBotGame(page)

  // You and one seat the room plays, each with a name of its own.
  await expect(page.getByTestId('player-red')).toContainText('Robin')
  await expect(page.getByTestId('player-blue')).toContainText('Jules')
  // The seat nobody is behind says so, and is never described as away.
  await expect(page.getByTestId('player-blue')).toContainText('AI')
  await expect(page.locator('.hh-away-badge')).toHaveCount(0)

  // Hearth deals seat one the first turn, so the die is yours to throw.
  await expect(rollButton(page)).toBeEnabled({ timeout: 20000 })
  await rollButton(page).click()
  // The number is the server's. The die lands, and the table either offers a
  // piece to move or passes the turn on — both of them the room's decision.
  await expect(
    page.getByRole('button', { name: /^Move piece/ }).or(page.getByRole('heading', { name: /’s turn/ })),
  ).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: 'test-results/hearth-desktop-game.png', fullPage: true })
  expect(errors).toEqual([])
})

test('a custom table reaches the game the server deals', async ({ page }) => {
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
  // Rules the room used to throw away: the adapter now narrows and keeps them.
  await page.getByLabel('Pieces per player').selectOption('1')
  await startBotGame(page)
  await expect(page.getByTestId('player-red')).toContainText('0 / 1', { timeout: 20000 })
})

test('a quick table is dealt quick, not classic', async ({ page }) => {
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: 'Quick', exact: true }).click()
  await startBotGame(page)
  // Two pieces each is what "quick" means, and it only survives because the
  // adapter carries `mode` across now.
  await expect(page.getByTestId('player-red')).toContainText('0 / 2', { timeout: 20000 })
})

test('mobile setup, rules and custom settings remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/hearth-and-home')
  await page.screenshot({ path: 'test-results/hearth-mobile-setup.png', fullPage: true })
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'A little luck. A few simple rules.' })).toBeVisible()
  await page.getByRole('button', { name: 'Got it. Let’s play.' }).click()
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
  await page.getByLabel('Pieces per player').selectOption('1')
  await page.getByLabel('Exact roll to finish').uncheck()
  await startBotGame(page)
  await expect(page.getByRole('heading', { name: /’s turn/ })).toBeVisible({ timeout: 20000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/hearth-mobile-game.png', fullPage: true })
})

test('sound, settings and camera controls work at a live table', async ({ page }) => {
  await page.goto('/#/hearth-and-home')
  await startBotGame(page)
  await expect(rollButton(page)).toBeEnabled({ timeout: 20000 })
  await page.getByRole('button', { name: 'Turn sound on', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mute sound', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Game settings', exact: true }).click()
  await expect(page.getByLabel('Game sounds')).toBeChecked()
  await page.keyboard.press('Escape')
  for (const label of ['Zoom in', 'Top view', 'Reset camera'])
    await page.getByRole('button', { name: label, exact: true }).click()
  await expect(rollButton(page)).toBeEnabled()
  await expect(page.getByTestId('player-red')).toContainText('4 in nest')
  // The table belongs to the room: there is nothing one player may pause.
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Leave room', exact: true })).toBeVisible()
})
