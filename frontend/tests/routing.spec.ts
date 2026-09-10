import { expect, test } from '@playwright/test'

for (const path of ['/', '/#/missing-game']) {
  test(`shows the game collection at ${path}`, async ({ page }) => {
    await page.goto(path)

    await expect(page.getByRole('heading', { name: 'Pick your next game.' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Play Hearth & Home' })).toHaveAttribute(
      'href',
      '#/hearth-and-home',
    )
    await expect(page.getByRole('link', { name: 'Play Estate' })).toHaveAttribute('href', '#/estate')
    await expect(page).toHaveTitle('Games — A little play goes a long way.')
    await expect(page.locator('canvas')).toHaveCount(0)
  })
}

for (const game of [
  { name: 'Hearth & Home', path: '/hearth-and-home', heading: 'Gather around.' },
  { name: 'Estate', path: '/estate', heading: 'Let the good times roll.' },
]) {
  test(`opens ${game.name} from the collection and supports refresh and return`, async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: `Play ${game.name}` }).click()
    await expect(page).toHaveURL(`/#${game.path}`)
    await expect(page.getByRole('heading', { name: game.heading, exact: true })).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(game.name))

    await page.reload()
    await expect(page).toHaveURL(`/#${game.path}`)
    await expect(page.getByRole('button', { name: /^Start game/ })).toBeVisible()
    await page.getByRole('link', { name: 'All games', exact: true }).click()
    await expect(page).toHaveURL('/#/')
    await expect(page.getByRole('heading', { name: 'Pick your next game.' })).toBeVisible()
    await expect(page).toHaveTitle('Games — A little play goes a long way.')
  })
}

for (const [oldPath, canonicalPath, heading] of [
  ['/Ludo', '/hearth-and-home', 'Gather around.'],
  ['/Hearth', '/hearth-and-home', 'Gather around.'],
  ['/Monopoly', '/estate', 'Let the good times roll.'],
]) {
  test(`redirects the old ${oldPath} link to ${canonicalPath}`, async ({ page }) => {
    await page.goto(`/#${oldPath}`)
    await expect(page).toHaveURL(`/#${canonicalPath}`)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  })
}

test('the collection is usable on mobile and after visiting both games', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  for (const name of ['Hearth & Home', 'Estate']) {
    await page.getByRole('link', { name: `Play ${name}` }).click()
    await page.getByRole('link', { name: 'All games', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Pick your next game.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/collection-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.screenshot({ path: 'test-results/collection-desktop.png', fullPage: true })
})
