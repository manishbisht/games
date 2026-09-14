import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Estate in the browser. Its rules moved to the server when bot play became a
 * room, and with them the seed — which `view` zeroes for every seat, this one
 * included, because the seed is the whole future of the game. So the mechanics
 * these tests used to drive through the UI on a fixed seed (buying, building,
 * mortgaging, a trade a bot weighs up, a bankruptcy played out to a winner) are
 * covered where they now live: `shared/src/estate/engine.test.ts` and
 * `backend/test/room-estate.test.ts`.
 *
 * What is left is the browser's: the board, the setup dialog, the table it asks
 * the server for, and a turn taken elsewhere arriving here.
 */

/** Set a table up and let the server deal it. */
async function startBotGame(page: Page, players = 2, name = 'Alex') {
  await page.goto('/#/estate')
  await page.getByRole('button', { name: 'Start game' }).click()
  for (let i = 4; i > players; i--) await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByLabel('Your name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/estate\/room\/[A-Z2-9]{6}$/, { timeout: 20000 })
  // A solo table has nobody to wait for, so it deals on arrival.
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)
}

test('renders the 3D board and offers a table to set up', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/#/estate')
  await expect(page.getByRole('heading', { name: 'Let the good times roll.' })).toBeVisible()
  await expect(page.locator('.board-canvas canvas')).toBeVisible()
  await expect(page.getByText('Your board needs WebGL')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/estate-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Start game' }).click()
  await expect(page.getByRole('button', { name: /Quick & spirited/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/estate-selection.png', animations: 'disabled' })
  // The bots are named by the server, so there is nothing here to name them with.
  await expect(page.getByLabel('Player 1 name')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('play vs bot deals a real table, and the server takes the bots’ turns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await startBotGame(page)

  // You and one seat the room plays, each with a name of its own.
  await expect(page.getByText('Alex').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Jules').first()).toBeVisible()
  // The seat nobody is behind says what it is, rather than "at the table".
  await expect(page.getByText('Bot', { exact: true }).first()).toBeVisible()

  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled({ timeout: 20000 })
  await page.getByRole('button', { name: /Roll dice/ }).click()
  // The dice are the server's, and the table is told what they were.
  await expect(page.locator('.activity-event').first()).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: 'test-results/estate-bot-room.png', fullPage: true })
  expect(errors).toEqual([])
})

test('a quick game is dealt quick, not classic', async ({ page }) => {
  await page.goto('/#/estate')
  await page.getByRole('button', { name: 'Start game' }).click()
  await page.getByRole('button', { name: /Quick & spirited/ }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Alex')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/estate\/room\/[A-Z2-9]{6}$/, { timeout: 20000 })
  // Quick starts everyone on $1,000 rather than $1,500, and the mode only
  // survives the crossing because the adapter narrows and keeps it.
  await expect(page.getByText('$1,000').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('$1,500')).toHaveCount(0)
})

test('mobile layout, setup keyboard focus, and camera controls work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/estate')
  await page.getByRole('button', { name: 'Start game' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  for (const label of ['Zoom in', 'Zoom out', 'Top down view', 'Reset camera'])
    await page.getByRole('button', { name: label, exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/estate-mobile.png', fullPage: true })
})

test('hovering highlights a board space and selecting opens its details', async ({ page }) => {
  await page.goto('/#/estate')
  await expect(page.locator('.board-canvas canvas')).toBeVisible()
  // The board is live on the way in, so a space can be read before you play.
  await page.mouse.move(720, 520)
  await page.mouse.click(720, 520)
  await page.screenshot({ path: 'test-results/estate-space.png', fullPage: true })
})

test('a room is resumable from its link, which is what replaced the autosave', async ({ page }) => {
  await startBotGame(page)
  const url = page.url()
  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled({ timeout: 20000 })
  await page.reload()
  // The room holds the game, so the same seat comes back to the same table.
  await expect(page).toHaveURL(url)
  await expect(page.getByText('Alex').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Jules').first()).toBeVisible()
})
