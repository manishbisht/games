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

test('a full local round deals, plays, draws, calls, changes color, wins and restarts', async ({ page }) => {
  test.setTimeout(180000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    let seed = 42
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
  })
  await page.goto('/#/prism')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: 'Local friends', exact: true }).click()
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
  await expect(page.locator('.pr-card')).toHaveCount(7)
  await page.screenshot({ path: 'test-results/prism-desktop-game.png', fullPage: true })
  let testedLateCall = false
  let plays = 0,
    draws = 0,
    wilds = 0,
    calls = 0
  for (let turn = 0; turn < 500; turn++) {
    if (await page.getByRole('dialog', { name: 'Round result', exact: true }).count()) break
    const handoff = page.getByRole('dialog', { name: 'Pass the device', exact: true })
    if (await handoff.count()) {
      await expect(page.locator('.pr-card')).toHaveCount(0)
      const call = handoff.getByRole('button', { name: /Call Prism/ })
      if ((await call.count()) && testedLateCall) {
        await call.click()
        calls++
      }
      await handoff.getByRole('button', { name: /show my hand/ }).click()
      if (!testedLateCall && (await page.locator('.pr-catch').count())) {
        const lateCall = page.getByRole('button', { name: 'Prism!', exact: true })
        await expect(lateCall).toBeVisible({ timeout: 2000 })
        await lateCall.click()
        testedLateCall = true
        calls++
      }
    }
    const call = page.locator('.pr-hand-toolbar .pr-call')
    if ((await call.isEnabled()) && testedLateCall) {
      await call.click()
      calls++
    }
    const legal = page.locator('.pr-card:enabled')
    if (await legal.count()) {
      await legal.first().focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Play card', exact: true }).click()
      const colors = page.getByRole('dialog', { name: 'Choose a color', exact: true })
      if (await colors.count()) {
        await colors.getByRole('button', { name: 'Choose red', exact: true }).click()
        wilds++
      }
      plays++
    } else {
      const keep = page.getByRole('button', { name: 'Keep & pass', exact: true })
      if (await keep.count()) await keep.click()
      else {
        await page.getByRole('button', { name: 'Draw card', exact: true }).click()
        draws++
      }
    }
  }
  await expect(page.getByRole('dialog', { name: 'Round result' })).toContainText('wins!')
  expect(plays).toBeGreaterThan(10)
  expect(draws).toBeGreaterThan(0)
  expect(wilds).toBeGreaterThan(0)
  expect(calls).toBeGreaterThan(0)
  expect(testedLateCall).toBe(true)
  await page.screenshot({ path: 'test-results/prism-result.png', fullPage: true })
  await page.getByRole('button', { name: 'Play again', exact: true }).click()
  await expect(page.locator('.pr-round')).toContainText('ROUND 02')
  await expect(page.locator('.pr-card')).toHaveCount(7)
  await page.getByRole('button', { name: 'Leave game', exact: true }).click()
  await page.getByRole('button', { name: 'Return to menu', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'A little color. A little chaos.' })).toBeVisible()
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
