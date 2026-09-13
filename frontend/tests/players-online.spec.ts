import { expect, test } from '@playwright/test'

// Counts are lower-bounded, never exact: wrangler dev keeps presence rows
// across runs, and other specs' page loads emit real heartbeats too.

test('a game page shows its own players-online badge', async ({ page }) => {
  await page.goto('/#/prism')
  await expect(page.locator('.pr-online-badge')).toHaveText(/\d+ online/)
})

test('a second person on the same game raises its count', async ({ page, browser }) => {
  await page.goto('/#/prism')
  // The first visitor's own beat must have landed before the second arrives,
  // or the second page's only beat for 30s could miss them.
  await expect(page.locator('.pr-online-badge')).toHaveText(/\d+ online/)

  // A separate context has its own localStorage, so it is a second person.
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await otherPage.goto('/#/prism')
  await expect
    .poll(async () => {
      const text = (await otherPage.locator('.pr-online-badge').textContent()) ?? ''
      return Number(/\d+/.exec(text)?.[0] ?? 0)
    })
    .toBeGreaterThanOrEqual(2)
  await other.close()
})
