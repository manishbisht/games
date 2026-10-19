import { expect, test } from '@playwright/test'

/**
 * A first game's guide: five coach marks, each on the real thing, the first of
 * which is taken by actually rolling. It is remembered once seen, and offered
 * again from the rules.
 */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('the first game walks a new player through a roll, a hop, a ladder, a snake and the finish', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/wildrise')
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/, { timeout: 30000 })

  const guide = page.getByRole('dialog', { name: 'Roll the die' })
  await expect(guide).toBeVisible({ timeout: 30000 })
  await expect(guide).toContainText('1 OF 5')
  // The ring sits round the real roll button.
  const roll = page.getByRole('button', { name: 'Roll dice', exact: true })
  const ring = page.locator('.wr-guide-ring')
  await expect(ring).toBeVisible()
  const [ringBox, rollBox] = [(await ring.boundingBox())!, (await roll.boundingBox())!]
  expect(ringBox.x).toBeLessThanOrEqual(rollBox.x)
  expect(ringBox.y + ringBox.height).toBeGreaterThanOrEqual(rollBox.y + rollBox.height)

  // Nothing is blocked: the roll itself is the way on.
  await expect(roll).toBeEnabled({ timeout: 40000 })
  await roll.click()
  await expect(page.getByRole('dialog', { name: 'Your token hops' })).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Ladders climb' })).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Snakes slide' })).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const finish = page.getByRole('dialog', { name: 'An exact roll to 100' })
  await expect(finish).toContainText('5 OF 5')
  await page.getByRole('button', { name: 'Let’s play' }).click()
  await expect(finish).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('games-guide-wildrise'))).toBe('done')

  // Seen once, it stays away — until asked for from the rules.
  await page.reload()
  await expect(page.locator('.wr-players')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.wr-guide-card')).toHaveCount(0)
  await page.getByRole('button', { name: 'How to play' }).click()
  await page.getByRole('button', { name: 'Show the guide again' }).click()
  await expect(page.getByRole('dialog', { name: 'Roll the die' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.wr-guide-card')).toHaveCount(0)
  expect(errors).toEqual([])
})
