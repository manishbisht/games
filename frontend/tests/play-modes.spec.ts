import { expect, test } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/estate'

for (const [id, path] of [
  ['hearth', '/hearth-and-home'],
  ['estate', '/estate'],
  ['prism', '/prism'],
  ['wildrise', '/wildrise'],
]) {
  test(`${id} offers bot play and online rooms without local player controls`, async ({ page }) => {
    await page.goto(`/#${path}`)
    if (id === 'estate') await page.getByRole('button', { name: /^Start game/ }).click()
    await expect(page.getByRole('button', { name: 'Play vs bot', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: /Local friends|Play local/ })).toHaveCount(0)
    await expect(page.locator('option[value="human"]')).toHaveCount(0)
    await page.screenshot({
      path: `test-results/${id}-bot-options.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Play online', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Play online', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
    if (id === 'prism') {
      expect(
        await page.locator('.pr-setup').evaluate((setup) => {
          const arena = setup.closest('main')!
          return setup.getBoundingClientRect().bottom <= arena.getBoundingClientRect().bottom
        }),
      ).toBe(true)
    }
    await page.screenshot({
      path: `test-results/${id}-online-options.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByLabel('Your name', { exact: true }).fill('Robin')
    await page.getByRole('button', { name: 'Create room', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path}/room/[A-Z2-9]{6}$`))
    await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible()
    await page.getByRole('link', { name: 'Leave room', exact: true }).click()
    await expect(page).toHaveURL(`/#${path}`)
  })
}

test('an old Estate multiplayer save returns to setup instead of resuming local play', async ({ page }) => {
  const saved = gameReducer(createGame(), {
    type: 'START',
    players: [
      { name: 'Alex', isBot: false },
      { name: 'Sam', isBot: false },
    ],
    mode: 'classic',
    seed: 42,
  })
  await page.addInitScript((state) => localStorage.setItem('estate-game-v1', JSON.stringify(state)), saved)
  await page.goto('/#/estate')
  await expect(page.getByRole('button', { name: /^Start game/ })).toBeVisible()
  await page.getByRole('button', { name: /^Start game/ }).click()
  await expect(page.getByRole('button', { name: 'Play vs bot', exact: true })).toBeVisible()
})

for (const [id, path] of [
  ['hearth', '/hearth-and-home'],
  ['estate', '/estate'],
  ['prism', '/prism'],
  ['wildrise', '/wildrise'],
]) {
  test(`${id} mode controls and room form fit on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/#${path}`)
    if (id === 'estate') await page.getByRole('button', { name: /^Start game/ }).click()
    const online = page.getByRole('button', { name: 'Play online', exact: true })
    await online.scrollIntoViewIfNeeded()
    await expect(online).toBeInViewport()
    await page.screenshot({
      path: `test-results/${id}-bot-options-mobile.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await online.click()
    await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
    if (id === 'prism') {
      expect(
        await page.locator('.pr-setup').evaluate((setup) => {
          const arena = setup.closest('main')!
          return setup.getBoundingClientRect().bottom <= arena.getBoundingClientRect().bottom
        }),
      ).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: `test-results/${id}-online-options-mobile.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Play vs bot', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Play online', exact: true })).toHaveCount(0)
  })
}
