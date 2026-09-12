import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/estate'
import type { GameState } from '@games/shared/estate/types'

function fixture() {
  return gameReducer(createGame(), {
    type: 'START',
    players: [
      { name: 'Alex', isBot: false },
      { name: 'Sam', isBot: false },
    ],
    mode: 'classic',
    seed: 42,
  })
}
async function loadFixture(page: Page, state: GameState) {
  await page.addInitScript((s) => localStorage.setItem('estate-game-v1', JSON.stringify(s)), state)
  await page.goto('/#/estate')
}

test('renders the 3D board and supports setup, rolling, buying, and continued turns', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.clock.setFixedTime(new Date(42))
  await page.goto('/#/estate')
  await expect(page.getByRole('heading', { name: 'Let the good times roll.' })).toBeVisible()
  await expect(page.locator('.board-canvas canvas')).toBeVisible()
  await expect(page.getByText('Your board needs WebGL')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/estate-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Start game' }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByLabel('Player 2 control').selectOption('human')
  await page.getByLabel('Player 1 name').fill('Alex')
  await page.getByLabel('Player 2 name').fill('Sam')
  await page.getByRole('button', { name: /Quick & spirited/ }).click()
  await page.screenshot({ path: 'test-results/estate-selection.png', animations: 'disabled' })
  await page.getByRole('button', { name: /The classic/ }).click()
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled()
  let bought = false
  for (let i = 0; i < 16; i++) {
    const roll = page.getByRole('button', { name: /Roll dice/ })
    if (await roll.count()) await roll.click()
    await expect(page.getByRole('button', { name: /Rolling the dice|On the move/ })).toHaveCount(0, {
      timeout: 15000,
    })
    const card = page.getByRole('button', { name: 'Let’s see what’s next' })
    if (await card.count()) {
      await card.click()
      await expect(page.getByRole('button', { name: /On the move/ })).toHaveCount(0, { timeout: 15000 })
    }
    const buy = page.getByRole('button', { name: /Buy for/ })
    if (await buy.count()) {
      await buy.click()
      bought = true
      await expect(page.locator('.activity-event').first()).toContainText('bought')
      await page.screenshot({ path: 'test-results/estate-purchased.png', fullPage: true })
    }
    const end = page.getByRole('button', { name: /End turn|Roll again/ })
    if (await end.count()) await end.click()
    if (bought) break
  }
  expect(bought).toBe(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Start game' })).toHaveCount(0)
  await page.getByRole('button', { name: /My properties/ }).click()
  await page.getByRole('button', { name: 'All properties' }).click()
  await expect(page.locator('.portfolio-property')).toHaveCount(28)
  await page.getByRole('button', { name: /Maple Lane/ }).click()
  await expect(page.getByRole('heading', { name: 'Maple Lane' })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  expect(errors).toEqual([])
})

test('mobile layout, setup keyboard focus, and camera controls work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/estate')
  await expect(page.locator('.board-canvas canvas')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/estate-mobile.png', fullPage: true })
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Top down view' }).click()
  await page.getByRole('button', { name: 'Reset camera' }).click()
  await page.getByRole('button', { name: 'Start game' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: 'test-results/estate-setup-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Game settings' }).click()
  await page.getByRole('switch', { name: 'Faster computer turns' }).click()
  await expect(page.getByRole('switch', { name: 'Faster computer turns' })).toBeChecked()
})

test('computer players buy and finish their own turns', async ({ page }) => {
  const s = fixture()
  s.players[1].isBot = true
  s.current = 1
  await loadFixture(page, s)
  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled({ timeout: 20000 })
  await expect(page.getByRole('button', { name: /Sam, \$1,440, 1 properties/ })).toBeVisible()
  await expect(page.locator('.activity-feed')).toContainText('Sam bought Cedar Court')
})

test('hovering highlights a board space and selecting opens its details', async ({ page }) => {
  await page.goto('/#/estate')
  const canvas = page.locator('.board-canvas canvas')
  await expect(canvas).toBeVisible()
  const bounds = (await canvas.boundingBox())!
  const x = bounds.x + bounds.width * 0.53,
    y = bounds.y + bounds.height * 0.795
  await page.mouse.move(x, y)
  await expect(page.getByRole('tooltip')).toBeVisible()
  const name = await page.locator('.board-tooltip strong').textContent()
  await page.screenshot({ path: 'test-results/estate-hover.png', animations: 'disabled' })
  await page.mouse.click(x, y)
  await expect(page.getByRole('dialog').getByRole('heading', { name: name! })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('builds, sells, and mortgages with clear balances and ownership', async ({ page }) => {
  const s = fixture()
  s.properties[1] = { owner: 0, level: 0, mortgaged: false }
  s.properties[3] = { owner: 0, level: 0, mortgaged: false }
  await loadFixture(page, s)
  await page.getByRole('button', { name: /My properties/ }).click()
  await page.getByRole('button', { name: /Cedar Court/ }).click()
  await page.getByRole('button', { name: /Build a house/ }).click()
  await expect(page.getByRole('button', { name: /Mortgage ·/ })).toBeDisabled()
  await page.getByRole('button', { name: /Sell a building/ }).click()
  await page.getByRole('button', { name: /Mortgage ·/ }).click()
  await expect(page.getByText('Mortgaged · No rent is collected')).toBeVisible()
  await expect(page.getByRole('button', { name: /Build a house/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('button', { name: /Alex, \$1,505/ })).toBeVisible()
})

test('trading waits for both confirmations and exchanges assets', async ({ page }) => {
  const s = fixture()
  s.properties[1] = { owner: 0, level: 0, mortgaged: false }
  s.properties[3] = { owner: 1, level: 0, mortgaged: false }
  await loadFixture(page, s)
  await page.getByRole('button', { name: 'Make a trade' }).click()
  await page.getByLabel('Cash you offer').fill('100')
  await page.getByRole('checkbox', { name: /Maple Lane/ }).check()
  await page.getByRole('checkbox', { name: /Cedar Court/ }).check()
  await page.getByRole('button', { name: 'Confirm & send offer' }).click()
  await expect(page.getByText('Pass the device to Sam to review and confirm.')).toBeVisible()
  await page.getByRole('button', { name: 'Accept as Sam' }).click()
  await expect(page.getByRole('button', { name: /Alex, \$1,400/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Sam, \$1,600/ })).toBeVisible()
  await expect(page.locator('.activity-event').first()).toContainText('Assets exchanged')
})

test('restores a pending trade after reloading', async ({ page }) => {
  const s = fixture()
  s.trade = { from: 0, to: 1, giveCash: 100, getCash: 0, giveProperties: [], getProperties: [] }
  await loadFixture(page, s)
  await expect(page.getByRole('button', { name: 'Accept as Sam' })).toBeVisible()
  await page.getByRole('button', { name: 'Decline' }).click()
  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled()
})

test('resolves bankruptcy, celebrates the winner, and starts again', async ({ page }) => {
  const s = fixture()
  s.players[0].cash = 0
  s.players[0].position = 39
  s.phase = 'debt'
  s.debt = { amount: 2000, creditor: 1, reason: 'Crown Promenade rent' }
  s.properties[39] = { owner: 1, level: 5, mortgaged: false }
  await loadFixture(page, s)
  await page.getByRole('button', { name: 'Declare bankruptcy' }).click()
  await expect(page.getByRole('heading', { name: 'Sam wins!' })).toBeVisible()
  await page.screenshot({ path: 'test-results/estate-winner.png' })
  await page.getByRole('button', { name: 'One more round?' }).click()
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page.getByRole('button', { name: /Roll dice/ })).toBeEnabled()
  await expect(page.locator('.player-card')).toHaveCount(4)
})
