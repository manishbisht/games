import { expect, test } from '@playwright/test'

/**
 * The first-game guide, walked once at each width: it opens for a seated
 * player's first game, points at the real board, moves on when the player
 * selects and moves, steps through the rest, and stays away once seen —
 * until How to play asks for it again. Screenshots of every step land in
 * test-results/ to be looked at.
 */
for (const viewport of [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
]) {
  test(`the first-game guide walks a new player through the table at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(90000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await page.addInitScript(() => {
      localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false }))
      localStorage.setItem('games-motion', 'reduced')
    })
    await page.goto('/#/chess')
    await page.getByLabel('Your name', { exact: true }).fill('Robin')
    await page.getByRole('button', { name: 'Create room', exact: true }).click()
    await page.getByRole('button', { name: /Play as White/ }).click()
    await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
    await page.getByLabel('Bot skill for Play as Black', { exact: true }).selectOption('easy')
    await page.getByRole('button', { name: 'Add bot', exact: true }).click()
    await page.getByRole('button', { name: /^Start/ }).click()

    const guide = page.getByRole('dialog', { name: 'Pick up a piece.' })
    await expect(guide).toBeVisible({ timeout: 30000 })
    await expect(guide).toContainText('1 OF 5')
    await expect(guide).toBeFocused()
    const shot = (n: number) =>
      page.screenshot({ path: `test-results/chess-guide-${viewport.width}-${n}.png`, animations: 'disabled' })
    await shot(1)

    // The guide never stands in the way: the board takes the move, and each step follows it.
    const board = page.getByRole('group', { name: '3D chessboard', exact: true })
    await board.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Make your move.' })).toBeVisible()
    await shot(2)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Taking pieces.' })).toBeVisible()
    await expect(page.getByLabel('Move history')).toContainText('e4')
    await shot(3)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Check and checkmate.' })).toBeVisible()
    await shot(4)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Resign and rematch.' })).toBeVisible()
    await shot(5)
    await page.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(page.locator('.ch-guide-card')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('games-guide-chess'))).toBe('done')

    // Seen once, it stays away — until How to play asks for it again, and Escape puts it away.
    await page.reload()
    await expect(page.getByLabel('Move history')).toContainText('e4')
    await expect(page.locator('.ch-guide-card')).toHaveCount(0)
    await page.getByRole('button', { name: 'How to play' }).click()
    await page.getByRole('button', { name: 'Show the guide again', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Pick up a piece.' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ch-guide-card')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
