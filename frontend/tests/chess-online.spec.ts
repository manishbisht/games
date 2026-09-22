import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

const TURN = { w: 'White’s turn.', b: 'Black’s turn.' }

/**
 * Board keyboard navigation is view-relative (`sign = black ? -1 : 1` in ChessBoard), and online the
 * seat locks the orientation, so the arrows invert for whoever sits in the black seat.
 */
function keyboardPlayer(page: Page, seat: 'w' | 'b') {
  const board = page.getByRole('group', { name: '3D chessboard', exact: true })
  const status = page.locator('.ch-session .ch-panel-copy')
  const sign = seat === 'b' ? -1 : 1
  let current = 'e2'
  async function go(square: string) {
    await board.focus()
    const dx = (square.charCodeAt(0) - current.charCodeAt(0)) * sign
    const dy = (Number(square[1]) - Number(current[1])) * sign
    for (let i = 0; i < Math.abs(dx); i++) await page.keyboard.press(dx > 0 ? 'ArrowRight' : 'ArrowLeft')
    for (let i = 0; i < Math.abs(dy); i++) await page.keyboard.press(dy > 0 ? 'ArrowUp' : 'ArrowDown')
    current = square
  }
  return async (from: string, to: string) => {
    // Wait for our own turn: Enter is ignored while the board is disabled, so pressing early is lost.
    await expect(page.getByRole('heading', { name: TURN[seat], exact: true })).toBeVisible()
    await go(from)
    await page.keyboard.press('Enter')
    await expect(status).toContainText(`on ${from}`)
    await go(to)
    await page.keyboard.press('Enter')
  }
}

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false, reducedMotion: true }))
  })
  return page
}

test('two browsers create, join, and play in the same room', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/chess')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/chess\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await guest.goto(`/#/chess/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()
  await expect(guest.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await host.getByRole('button', { name: /Play as White/ }).click()
  // Your own occupied seat relabels itself as the way out of it.
  await expect(host.getByRole('button', { name: /Leave seat/ })).toContainText('Ann')
  await guest.getByRole('button', { name: /Play as Black/ }).click()
  // The host only learns the black seat is filled through the broadcast snapshot.
  await expect(host.getByRole('button', { name: /Play as Black/ })).toContainText('Ben')
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()

  await expect(host.locator('.ch-canvas canvas')).toBeVisible()
  await expect(guest.locator('.ch-canvas canvas')).toBeVisible()
  await expect(host.locator('.ch-player').filter({ hasText: 'Ben' })).toBeVisible()
  await expect(guest.locator('.ch-player').filter({ hasText: 'Ann' })).toBeVisible()

  const hostMove = keyboardPlayer(host, 'w')
  const guestMove = keyboardPlayer(guest, 'b')
  // An illegal destination leaves the position unchanged and can be corrected.
  await hostMove('e2', 'e5')
  await expect(host.getByLabel('Move history')).not.toContainText('e5')
  await host.keyboard.press('Escape')
  await hostMove('e2', 'e4')
  await expect(host.getByLabel('Move history')).toContainText('e4')
  await expect(guest.getByLabel('Move history')).toContainText('e4')
  await guestMove('e7', 'e5')
  await expect(host.getByLabel('Move history')).toContainText('e5')
  await expect(guest.getByLabel('Move history')).toContainText('e5')

  // A reload reconnects with the stored guest id, which reclaims the black seat and the live game.
  await guest.reload()
  await expect(guest.getByLabel('Move history')).toContainText('e5')
  await expect(guest.locator('.ch-player').filter({ hasText: 'Ben' })).toContainText('YOU')
  const guestMoveAgain = keyboardPlayer(guest, 'b')
  await hostMove('g1', 'f3')
  await expect(guest.getByLabel('Move history')).toContainText('Nf3')
  await guestMoveAgain('b8', 'c6')
  await expect(host.getByLabel('Move history')).toContainText('Nc6')
  await expect(host.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible()

  await host.screenshot({ path: 'test-results/chess-online-host.png', fullPage: true })
  await guest.screenshot({ path: 'test-results/chess-online-guest.png', fullPage: true })
  // Results and rematches keep both players in the online room.
  await host.getByRole('button', { name: 'Resign', exact: true }).click()
  await host.getByRole('button', { name: 'Resign game', exact: true }).click()
  await expect(host.getByRole('dialog', { name: 'Game result' })).toContainText('Black wins.')
  await expect(guest.getByRole('dialog', { name: 'Game result' })).toContainText('Black wins.')
  await host.getByRole('button', { name: 'Rematch', exact: true }).click()
  await expect(host.getByRole('button', { name: 'Waiting for opponent…' })).toBeDisabled()
  await guest.getByRole('button', { name: 'Accept rematch', exact: true }).click()
  await expect(host.getByRole('dialog', { name: 'Game result' })).toHaveCount(0)
  await expect(guest.getByRole('dialog', { name: 'Game result' })).toHaveCount(0)
  await expect(host.getByLabel('Move history')).not.toContainText('Nf3')
  expect(errors).toEqual([])
  await host.context().close()
  await guest.context().close()
})

test('public rooms appear in the lobby and can be joined', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)
  await host.goto('/#/chess')
  await host.getByLabel('Your name', { exact: true }).fill('Public host')
  await host.getByLabel('List in the public lobby').check()
  await host.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(host).toHaveURL(/#\/chess\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()
  await guest.goto('/#/chess')
  await guest.getByLabel('Your name', { exact: true }).fill('Guest')
  const join = guest.getByRole('button', { name: `Join ${code}`, exact: true })
  await expect(join).toBeVisible()
  await join.click()
  await expect(guest.getByRole('heading', { name: `Room ${code}` })).toBeVisible()
  expect(errors).toEqual([])
  await host.context().close()
  await guest.context().close()
})
