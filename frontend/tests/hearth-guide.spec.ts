import { expect, test } from '@playwright/test'

/**
 * A first game's guide: five coach marks, each on the real thing — the roll
 * button, your nest, the pieces to pick from, the board, your card — the
 * first of which is taken by actually rolling. The room never waits for it.
 * It is remembered once seen, and offered again from the rules.
 */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('the first game walks a new player from the first roll to bringing everyone home', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/hearth-and-home')
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/hearth-and-home\/room\/[A-Z2-9]{6}$/, { timeout: 30000 })

  const guide = page.getByRole('dialog', { name: 'Game guide' })
  await expect(guide).toBeVisible({ timeout: 30000 })
  await expect(guide).toContainText('1 OF 5')
  await expect(guide).toBeFocused()
  // The ring sits round the real roll button.
  const roll = page.getByRole('button', { name: 'Roll dice', exact: true }),
    ring = page.locator('.hh-guide-ring')
  await expect(roll).toBeEnabled({ timeout: 30000 })
  await expect
    .poll(async () => {
      const [around, button] = [(await ring.boundingBox())!, (await roll.boundingBox())!]
      return (
        around.x <= button.x &&
        around.y <= button.y &&
        around.x + around.width >= button.x + button.width &&
        around.y + around.height >= button.y + button.height
      )
    })
    .toBe(true)

  // Nothing is blocked: the roll itself is the way on.
  await roll.click()
  await expect(guide).toContainText('2 OF 5')
  await expect(guide).toContainText('only a 6 lets one out')
  await guide.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(guide).toContainText('pick a glowing piece')
  await guide.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(guide).toContainText('send it back to its nest')
  await guide.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(guide).toContainText('5 OF 5')
  await expect(guide).toContainText('Bring all 4 pieces home')
  await guide.getByRole('button', { name: 'Let’s play' }).click()
  await expect(guide).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('games-guide-hearth'))).toBe('done')

  // Seen once, it stays away — until asked for from the rules.
  await page.reload()
  await expect(page.getByTestId('player-red')).toContainText('Robin', { timeout: 30000 })
  await expect(guide).toHaveCount(0)
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await page.getByRole('button', { name: 'Show the guide again' }).click()
  await expect(guide).toContainText('1 OF 5')
  await page.keyboard.press('Escape')
  await expect(guide).toHaveCount(0)
  expect(errors).toEqual([])
})
