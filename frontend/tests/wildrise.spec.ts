import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Wildrise in the browser. The rules moved to the server when bot play became a
 * room, and with them the die — so what a stubbed `Math.random` used to prove
 * here (ladders, snakes, the exact roll, a whole game to victory) is covered by
 * `shared/src/wildrise/engine.test.ts` and `backend/test/room-wildrise.test.ts`
 * instead. What is left is genuinely the browser's: the setup panel, the table
 * it asks the server for, and that a turn taken elsewhere arrives here.
 */

const rollButton = (page: Page) => page.getByRole('button', { name: 'Roll dice', exact: true })

/** Set a table up and let the server deal it. */
async function startBotGame(page: Page, players?: number, name = 'Robin') {
  await page.goto('/#/wildrise')
  if (players) await page.getByRole('button', { name: `${players} players`, exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/, { timeout: 30000 })
  // A solo table has nobody to wait for, so it deals on arrival.
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('play vs bot deals a real table, and the server takes the bots’ turns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await startBotGame(page, 3)

  // Three seats: you and two the room plays, each with a name of its own.
  await expect(page.locator('.wr-players .wr-player-info strong')).toHaveCount(3, {
    timeout: 30000,
  })
  // The server decides who opens, so the turn may take a lap to reach you —
  // which is itself the bots playing without this browser doing anything.
  await expect(rollButton(page)).toBeEnabled({ timeout: 40000 })
  await expect(page.getByRole('heading', { name: 'Robin’s turn.' })).toBeVisible()

  await rollButton(page).click()
  await expect(rollButton(page)).toBeDisabled()
  // The number came from the server, and the table is told what it was.
  await expect(page.locator('.wr-events')).toContainText('rolled', { timeout: 30000 })
  // Then the seats nobody is behind take their turns and hand it back.
  await expect(rollButton(page)).toBeEnabled({ timeout: 40000 })
  await expect(page.getByRole('heading', { name: 'Robin’s turn.' })).toBeVisible()
  await page.screenshot({ path: 'test-results/wildrise-bot-room.png', fullPage: true })
  expect(errors).toEqual([])
})

test('the table settings reach the game the server deals', async ({ page }) => {
  await page.goto('/#/wildrise')
  await page.getByRole('button', { name: '4 players', exact: true }).click()
  // A rule the room used to throw away: the adapter now narrows and keeps it.
  await page.getByLabel('Exact roll to finish').uncheck()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/, { timeout: 30000 })
  await expect(page.locator('.wr-players .wr-player-info strong')).toHaveCount(4, {
    timeout: 30000,
  })
  // The rule survived the crossing: with it off the board says so, and the
  // adapter used to answer `validateOptions` with an empty object.
  await expect(page.getByText('Reach or pass 100 to finish.')).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('An exact roll brings you home.')).toHaveCount(0)
})

test('a seat the room plays reads as a bot, not as a person', async ({ page }) => {
  await startBotGame(page, 2)
  await expect(page.locator('.wr-players .wr-player-info strong')).toHaveCount(2, {
    timeout: 30000,
  })
  // The seat the room plays carries the bot mark; yours does not.
  const names = page.locator('.wr-players .wr-player-info strong')
  await expect(names.nth(1).locator('svg')).toHaveCount(1)
  await expect(names.nth(0).locator('svg')).toHaveCount(0)
  // And it is never described as someone who walked out. The badge, not the
  // word: getByText matches substrings case-insensitively, and the page says
  // "one roll away" twice.
  await expect(page.locator('.wr-away-badge')).toHaveCount(0)
})

test('mobile setup, rules, sound, camera and navigation work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/snakes-and-ladders')
  await expect(page).toHaveURL('/#/wildrise')
  await page.getByRole('button', { name: '4 players', exact: true }).click()
  await page.screenshot({ path: 'test-results/wildrise-mobile-setup.png', fullPage: true })
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  // Copy that does not move with the table settings.
  await expect(page.getByRole('dialog', { name: 'A few simple rules' })).toContainText(
    'Take a turn. Roll the die.',
  )
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Turn sound on', exact: true })).toBeVisible({
    timeout: 20000,
  })
  for (const label of ['Zoom in', 'Zoom out', 'Rotate left', 'Rotate right', 'Top view', 'Reset camera'])
    await page.getByRole('button', { name: label, exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/wildrise-mobile-game.png', fullPage: true })
  await page.getByRole('link', { name: 'All games', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Play Wildrise', exact: true })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('the physical die rolls on click in the normally rendered scene', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/#/wildrise')
  await expect(page.locator('.wr-canvas canvas')).toBeVisible()
  await page.screenshot({ path: 'test-results/wildrise-natural-setup.png', fullPage: true })
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(rollButton(page)).toBeEnabled({ timeout: 30000 })
  // The die is visible in its tray at this location in the default 1440×960 camera.
  await page.mouse.click(798, 680)
  await expect(rollButton(page)).toBeDisabled()
  await expect(page.locator('.wr-events')).toContainText('rolled', { timeout: 30000 })
})

test.describe('compact touch screens', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true })
  test('keeps the board and roll control visible without horizontal overflow', async ({ page }) => {
    await startBotGame(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.locator('.wr-canvas canvas')).toBeInViewport()
    await expect(rollButton(page)).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(rollButton(page)).toBeEnabled({ timeout: 30000 })
    await rollButton(page).tap()
    await expect(page.locator('.wr-events')).toContainText('rolled', { timeout: 30000 })
    await page.screenshot({ path: 'test-results/wildrise-touch-320.png' })
  })
})
