import { expect, test } from '@playwright/test'

test('starts a bot game, rolls six, enters a piece and grants a bonus turn', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    Math.random = () => 0.99
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/hearth-and-home')
  await expect(page.getByRole('heading', { name: 'Gather around.' })).toBeVisible()
  await page.screenshot({ path: 'test-results/hearth-desktop-setup.png', fullPage: true })
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Red’s turn' })).toBeVisible()
  await page.getByRole('button', { name: 'Roll dice', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move piece 1', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Move piece 1', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Red’s turn' })).toBeVisible()
  await expect(page.getByTestId('player-red')).toContainText('1 on board')
  await expect(page.locator('.hh-canvas canvas')).toBeVisible()
  await expect(page.getByText('The 3D board needs WebGL.')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/hearth-desktop-game.png', fullPage: true })
  expect(errors).toEqual([])
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
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Red’s turn' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/hearth-mobile-game.png', fullPage: true })
})

test('the human and a bot alternate turns through victory and can play again', async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    Math.random = () => 0.99
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
  await page.getByLabel('Pieces per player').selectOption('1')
  await page.getByLabel('Exact roll to finish').uncheck()
  await page.getByLabel('Bonus roll on 6').uncheck()
  await page.getByLabel('Allow captures').uncheck()
  await page.getByLabel('Blue player type').selectOption('medium')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  const result = page.getByRole('dialog', { name: 'Red wins!' })
  const roll = page.locator('.hh-roll-button')
  for (let turn = 0; turn < 15; turn++) {
    await expect
      .poll(async () => (await result.isVisible()) || (await roll.isEnabled()), { timeout: 10000 })
      .toBe(true)
    if (await result.isVisible()) break
    await roll.click()
    await expect(roll).toBeDisabled()
  }
  await expect(result).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('1/1 home')
  await page.screenshot({ path: 'test-results/hearth-victory.png', fullPage: true })
  await page.getByRole('button', { name: 'Play again', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('player-red')).toContainText('1 in nest')
  expect(errors).toEqual([])
})

test('pause, settings, sound and camera controls preserve the current game', async ({ page }) => {
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await page.getByRole('button', { name: 'Turn sound on', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mute sound', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Game paused', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to the table', exact: true }).click()
  await page.getByRole('button', { name: 'Game settings', exact: true }).click()
  await expect(page.getByLabel('Game sounds')).toBeChecked()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Top view', exact: true }).click()
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled()
  await expect(page.getByTestId('player-red')).toContainText('4 in nest')
})

test('pausing a moving piece preserves its remaining animation time', async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0.99
  })
  await page.clock.install({ time: new Date('2026-09-09T00:00:00Z') })
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await page.clock.pauseAt(new Date('2026-09-09T00:00:10Z'))
  await page.getByRole('button', { name: 'Roll dice', exact: true }).click()
  await page.clock.runFor(1150)
  await page.getByRole('button', { name: 'Move piece 1', exact: true }).click()
  await page.clock.runFor(500)
  await page.getByRole('button', { name: 'Roll dice', exact: true }).click()
  await page.clock.runFor(1150)
  await page.getByRole('button', { name: 'Move piece 1', exact: true }).click()
  await page.clock.runFor(300)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.clock.runFor(2000)
  await expect(page.getByRole('button', { name: 'Game paused', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to the table', exact: true }).click()
  await page.clock.runFor(950)
  // 300ms before pause + 950ms after resume completes the 1210ms motion.
  // A restarted timeout incorrectly keeps the player waiting another 300ms.
  expect(await page.getByRole('button', { name: 'Roll dice', exact: true }).isEnabled()).toBe(true)
})
