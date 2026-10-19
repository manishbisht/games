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
    // The game's chunk (Three.js for chess/prism) is fetched on the way in; under a
    // cold dev server that can take longer than Playwright's default 5s wait.
    await expect(page.getByRole('heading', { name: game.heading, exact: true })).toBeVisible({
      timeout: 30000,
    })
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

for (const path of ['/hearth-and-home', '/estate', '/chess', '/prism', '/wildrise']) {
  test(`a bogus room code under ${path} reaches the room page, not the 404 redirect`, async ({ page }) => {
    // "ABCDEF" is well-formed (six letters from the room-code alphabet) but no such
    // room exists, so this exercises the room page's own UI rather than the invalid-
    // code notice or the catch-all redirect to home.
    await page.goto(`/#${path}/room/ABCDEF`)
    await expect(page).toHaveURL(`/#${path}/room/ABCDEF`)
    await expect(page.getByRole('heading', { name: 'Pick a name to join the table.' })).toBeVisible()
  })
}

test('a room code that is not six characters is turned away by the room page itself', async ({ page }) => {
  // The route matches, so this is the room page saying no rather than the
  // catch-all redirect: a malformed code never becomes a lookup.
  await page.goto('/#/wildrise/room/ABC')
  await expect(page).toHaveURL('/#/wildrise/room/ABC')
  await expect(page.getByRole('heading', { name: 'That link looks wrong.' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to Wildrise' }).click()
  await expect(page).toHaveURL('/#/wildrise')
})

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

test('a game whose code never arrives offers a way out, not a spinner', async ({ page }) => {
  // The real cause is an old tab: an index.html from the last deploy asking for
  // chunks this one no longer has. A rejected lazy import rejects for good, so
  // without a boundary the player waits on "Loading game…" forever.
  await page.route('**/HearthGame*', (route) => route.abort())
  await page.goto('/#/hearth-and-home')
  await expect(page.getByRole('heading', { name: 'This game didn’t load.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
  await expect(page.getByText('Loading game…')).toHaveCount(0)
})

/**
 * The router runs on React Router's hash history through two exports it marks
 * unstable (see `createAppHistory` in navigation.ts), with every navigation
 * wrapped in a view transition. This is the walk that has to keep working
 * across an upgrade of that pin: in through a card, out through the link, and
 * the browser's own back and forward between them — with motion on, so every
 * one of those goes through `document.startViewTransition`.
 */
test('back, forward and home → game → home all land, with view transitions on', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('games-motion', 'full')
    // Every view transition the page starts, by the kind navigation.ts tags
    // `<html data-vt>` with just before starting it.
    const kinds: string[] = []
    ;(window as unknown as { __vt: string[] }).__vt = kinds
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
      kinds.push(document.documentElement.dataset.vt ?? '')
      return start(update)
    }) as typeof document.startViewTransition
  })
  const home = page.getByRole('heading', { name: 'Pick your next game.' })
  const estate = page.getByRole('heading', { name: 'Let the good times roll.', exact: true })
  const hearth = page.getByRole('heading', { name: 'Gather around.', exact: true })

  await page.goto('/')
  await expect(home).toBeVisible()
  await page.getByRole('link', { name: 'Play Estate' }).click()
  await expect(page).toHaveURL('/#/estate')
  await expect(estate).toBeVisible({ timeout: 30000 })

  // Back to the very first entry, which was the bare `/` the test opened.
  await page.goBack()
  await expect(page).toHaveURL(/\/(#\/)?$/)
  await expect(home).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL('/#/estate')
  await expect(estate).toBeVisible()

  await page.getByRole('link', { name: 'All games', exact: true }).click()
  await expect(page).toHaveURL('/#/')
  await expect(home).toBeVisible()
  await page.getByRole('link', { name: 'Play Hearth & Home' }).click()
  await expect(hearth).toBeVisible({ timeout: 30000 })
  // Game to game through history: two steps back is Estate, one more is home.
  await page.goBack()
  await page.goBack()
  await expect(page).toHaveURL('/#/estate')
  await expect(estate).toBeVisible()
  await page.goBack()
  await expect(home).toBeVisible()

  // Every move above animated, and the transitions let go of the page after.
  const kinds = await page.evaluate(() => (window as unknown as { __vt: string[] }).__vt)
  expect(kinds).toContain('open')
  expect(kinds).toContain('close')
  await expect(page.locator('html')).not.toHaveAttribute('data-vt', /.+/)
  expect(errors).toEqual([])
})
