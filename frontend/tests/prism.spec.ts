import { expect, test } from '@playwright/test'

test('Prism opens from the collection, renders its table, and has working settings and help', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('link', { name: 'Play Prism', exact: true }).click()
  await expect(page).toHaveURL('/#/prism')
  // The table is its own chunk, fetched on the way in. Under a cold dev server
  // the router keeps the collection on screen until it lands, which can take a
  // good deal longer than the default wait allows.
  await expect(page.getByRole('heading', { name: 'A little color. A little chaos.' })).toBeVisible({
    timeout: 30000,
  })
  await expect(page.locator('.pr-table-render canvas')).toBeVisible()
  await page.screenshot({ path: 'test-results/prism-desktop-menu.png', fullPage: true })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('switch', { name: 'Sound effects' }).click()
  await page.getByRole('switch', { name: 'Reduced motion' }).click()
  await page.getByRole('button', { name: 'All set' }).click()
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('One card? Call Prism!')
  await page.getByText('Meet the special cards', { exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(
    'Legal only when you have no card of the active color.',
  )
  await page.getByRole('button', { name: 'Back to the table' }).click()
  expect(errors).toEqual([])
})

test('a bot round is dealt by the server, and the bot plays without this tab', async ({ page }) => {
  test.setTimeout(120000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The deck is shuffled and every bot's card chosen on the server, so there is
  // no seeding this from here — which is the point. A whole round played to a
  // winner is covered where the rules now live: shared/src/prism/engine.test.ts
  // and backend/test/room-prism.test.ts.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/prism')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
  await expect(page).toHaveURL(/\/prism\/room\/[A-Z2-9]{6}$/, { timeout: 20000 })
  // Dealt on arrival: a solo table has nobody to wait for.
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)
  await expect(page.locator('.pr-card')).toHaveCount(7, { timeout: 20000 })

  // Your hand is the only one this browser holds. The bot's is a count.
  await expect(page.getByText('Jules')).toBeVisible()
  await expect(page.locator('.pr-opponent-info')).toContainText('cards')

  // Take a turn however the table allows, and let the bot answer it.
  const turnAction = page.getByRole('button', { name: /^(Draw card|Draw \d+|Keep & pass)$/ })
  await expect
    .poll(async () => await turnAction.isEnabled(), { timeout: 30000 })
    .toBe(true)
  await turnAction.click()
  // The server takes the seat nobody is behind, and the table says what it did.
  await expect(page.locator('.pr-feed, .pr-table-log')).toContainText(/Jules/, { timeout: 30000 })
  await page.screenshot({ path: 'test-results/prism-bot-room.png', fullPage: true })

  // The device is never passed: every hand but yours lives on the server.
  await expect(page.getByRole('dialog', { name: 'Pass the device', exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('mobile supports four players, hand scrolling, AI turns and touch-size controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/uno')
  await expect(page).toHaveURL('/#/prism')
  await page.screenshot({ path: 'test-results/prism-mobile-menu.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
  await expect(page.locator('.pr-opponent')).toHaveCount(3)
  await expect(page.locator('.pr-card')).toHaveCount(7)
  await page.screenshot({ path: 'test-results/prism-mobile-game.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const legal = page.locator('.pr-card:enabled')
  if (await legal.count()) {
    await legal.first().focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Play card', exact: true }).click()
    if (await page.getByRole('dialog', { name: 'Choose a color' }).count())
      await page.getByRole('button', { name: 'Choose blue', exact: true }).click()
  } else await page.getByRole('button', { name: 'Draw card', exact: true }).click()
  if (await page.getByRole('button', { name: 'Keep & pass', exact: true }).count())
    await page.getByRole('button', { name: 'Keep & pass', exact: true }).click()
  await expect(page.locator('.pr-opponent.pr-current')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Draw card', exact: true })).toBeEnabled({ timeout: 25000 })
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.getByRole('button', { name: 'Leave game' }).click()
  await page.getByRole('button', { name: 'Keep playing' }).click()
  await expect(page.locator('.pr-table-render canvas')).toBeVisible()
})
