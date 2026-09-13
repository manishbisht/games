import { expect, test } from '@playwright/test'

// These tests cover players-online surfaces that live in files still riding
// with in-progress work (HomePage.tsx, WildriseGame.tsx). Commit this spec
// together with that work. Counts are lower-bounded, never exact: wrangler
// dev keeps presence rows across runs, and other specs beat too.

test('the home page shows how many people are on the site', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.locator('.collection-online')).toHaveText(/\d+ online/)
})

test('a game with no online play still counts its visitors', async ({ page, browser }) => {
  // Sit on wildrise: the heartbeat tags the catalog id even though the game
  // has no online rooms.
  await page.goto('/#/wildrise')
  await expect(page.locator('.wr-online-badge')).toHaveText(/\d+ online/)

  // A separate context has its own localStorage, so it is a second person.
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await otherPage.goto('/#/')
  // Reload between polls: a tab refreshes its counts only on its own beats.
  await expect
    .poll(
      async () => {
        const badge = otherPage.locator('.collection-card-wildrise .collection-card-online')
        if (await badge.count()) return badge.textContent()
        await otherPage.reload()
        return ''
      },
      { timeout: 15000 },
    )
    .toMatch(/\d+ online/)
  await other.close()
})
