import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { LADDERS, SNAKES } from '@games/shared/wildrise/board'

async function chooseDie(page: Page, value: number) {
  await page.evaluate((n) => {
    ;(window as Window & { wildriseTestRandom: number }).wildriseTestRandom = (n - 0.5) / 6
  }, value)
}
/**
 * Take the human's turn. Every other seat is a bot playing on its own clock, so
 * waiting for the die to come back to Red is part of rolling it — and the bots
 * draw from the same stubbed source, which keeps a seeded game reproducible.
 */
async function roll(page: Page, value: number) {
  const button = page.getByRole('button', { name: 'Roll dice', exact: true })
  await expect(page.getByRole('heading', { name: 'Red’s turn.' })).toBeVisible({ timeout: 20000 })
  await expect(button).toBeEnabled({ timeout: 20000 })
  await chooseDie(page, value)
  await button.click()
  await expect(button).toBeDisabled()
}
async function position(page: Page, id: string, n: number) {
  await expect(page.getByTestId(`wildrise-player-${id}`).locator('.wr-position strong')).toHaveText(
    n === 0 ? '—' : String(n),
  )
}
function shortestRolls(from: number, goal: number) {
  const queue = [{ at: from, rolls: [] as number[] }],
    seen = new Set([from])
  while (queue.length) {
    const current = queue.shift()!
    if (current.at === goal) return current.rolls
    for (let die = 1; die <= 6; die++) {
      if (current.at + die > 100) continue
      const destination = current.at + die
      const at = [...LADDERS, ...SNAKES].find((r) => r.from === destination)?.to ?? destination
      if (!seen.has(at)) {
        seen.add(at)
        queue.push({ at, rolls: [...current.rolls, die] })
      }
    }
  }
  throw new Error(`No path from ${from} to ${goal}`)
}

test.beforeEach(async ({ page }, info) => {
  if (!info.title.includes('physical die'))
    await page.addInitScript(() => {
      const scope = window as Window & { wildriseTestRandom: number }
      scope.wildriseTestRandom = 0
      Math.random = () => scope.wildriseTestRandom
    })
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('plays a complete bot adventure: ladder, snake, exact-roll rejection and victory', async ({ page }) => {
  test.setTimeout(120000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/wildrise')
  await expect(page.getByRole('heading', { name: 'A little luck. A wild adventure.' })).toBeVisible()
  await expect(page.locator('.wr-canvas canvas')).toBeVisible()
  await expect(page.getByText('The 3D view needs WebGL.')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/wildrise-desktop-setup.png', fullPage: true })
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Red’s turn.' })).toBeVisible()
  await roll(page, 4)
  await position(page, 'red', 25)
  await expect(page.locator('.wr-events')).toContainText('Red climbed 4 → 25.')
  await roll(page, 2)
  await position(page, 'red', 56)
  await roll(page, 6)
  await position(page, 'red', 18)
  await expect(page.locator('.wr-events')).toContainText('Red slid 62 → 18.')
  await page.screenshot({ path: 'test-results/wildrise-desktop-game.png', fullPage: true })
  // Blue draws from the same stubbed die a beat later, so it shadows Red square
  // for square — one turn behind, and never in front of it.
  await position(page, 'blue', 18)
  let red = 18
  for (const value of shortestRolls(18, 97)) {
    red += value
    red = [...LADDERS, ...SNAKES].find((r) => r.from === red)?.to ?? red
    await roll(page, value)
    await position(page, 'red', red)
  }
  await roll(page, 5)
  await expect(page.getByText('Red needs a 3 to reach 100.', { exact: true }).first()).toBeVisible()
  await position(page, 'red', 97)
  await roll(page, 3)
  await expect(page.getByRole('dialog', { name: 'Red wins!' })).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('100FINAL POSITION')
  await page.screenshot({ path: 'test-results/wildrise-victory.png', fullPage: true })
  await chooseDie(page, 1)
  await page.getByRole('button', { name: 'Play again', exact: true }).click()
  await position(page, 'red', 0)
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start a new adventure', exact: true }).click()
  await page.getByRole('button', { name: 'Return to menu', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

for (const count of [2, 3, 4])
  test(`automates ${count - 1} fair AI opponents and returns control to the human`, async ({ page }) => {
    await page.goto('/#/wildrise')
    await page.getByRole('button', { name: `${count} players`, exact: true }).click()
    await page
      .getByLabel('Table personality')
      .selectOption(count === 2 ? 'casual' : count === 3 ? 'fast' : 'fun')
    await page.getByRole('button', { name: 'Start game', exact: true }).click()
    await roll(page, 3)
    await expect(page.getByRole('heading', { name: 'Blue’s turn.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'Red’s turn.' })).toBeVisible({ timeout: 15000 })
    for (const id of ['red', 'blue', 'green', 'yellow'].slice(0, count)) await position(page, id, 3)
    await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled()
  })

test('mobile setup, rules, keyboard roll, sound, camera and navigation work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/snakes-and-ladders')
  await expect(page).toHaveURL('/#/wildrise')
  await page.getByRole('button', { name: '4 players', exact: true }).click()
  await page.getByLabel('Red player name').fill('Robin')
  await page.getByLabel('Exact roll to finish').uncheck()
  await page.screenshot({ path: 'test-results/wildrise-mobile-setup.png', fullPage: true })
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'A few simple rules' })).toContainText(
    'Reach or pass square 100',
  )
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Robin’s turn.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Turn sound on', exact: true })).toBeVisible()
  for (const label of ['Zoom in', 'Zoom out', 'Rotate left', 'Rotate right', 'Top view', 'Reset camera'])
    await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('button', { name: 'Roll dice', exact: true }).focus()
  await chooseDie(page, 3)
  await page.keyboard.press('Space')
  await position(page, 'red', 3)
  await expect(page.getByRole('heading', { name: 'Blue’s turn.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/wildrise-mobile-game.png', fullPage: true })
  await page.getByRole('link', { name: 'All games', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Play Wildrise', exact: true })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('pausing a roll preserves its remaining animation time', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.clock.install()
  await page.goto('/#/wildrise')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await roll(page, 3)
  await page.clock.runFor(600)
  await page.getByRole('button', { name: 'Pause game', exact: true }).click()
  await page.clock.runFor(5000)
  await position(page, 'red', 0)
  await page.getByRole('button', { name: 'Back to the adventure', exact: true }).click()
  await page.clock.runFor(450)
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toHaveText('Rolling…')
  await page.clock.runFor(100)
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toHaveText('On the move…')
  await page.clock.runFor(1500)
  await position(page, 'red', 3)
  await expect(page.getByRole('heading', { name: 'Blue’s turn.' })).toBeVisible()
})

test('the physical die rolls on click in the normally rendered scene', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/#/wildrise')
  await expect(page.locator('.wr-canvas canvas')).toBeVisible()
  await page.screenshot({ path: 'test-results/wildrise-natural-setup.png', fullPage: true })
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled()
  // The die is visible in its tray at this location in the default 1440×960 camera.
  await page.mouse.click(798, 680)
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeDisabled()
  await expect(page.locator('.wr-events')).toContainText('rolled', { timeout: 5000 })
  // A bot seat takes its own turn at full animation speed before the die comes
  // back, so this waits out two whole turns rather than one.
  await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeEnabled({
    timeout: 25000,
  })
})

test.describe('compact touch screens', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true })
  test('keeps the board and roll control visible without horizontal overflow', async ({ page }) => {
    await page.goto('/#/wildrise')
    await page.getByRole('button', { name: 'Start game', exact: true }).click()
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.locator('.wr-canvas canvas')).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Roll dice', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Roll dice', exact: true }).tap()
    await position(page, 'red', 1)
    await expect(page.getByRole('heading', { name: 'Blue’s turn.' })).toBeVisible()
    await page.screenshot({ path: 'test-results/wildrise-touch-320.png' })
  })
})
