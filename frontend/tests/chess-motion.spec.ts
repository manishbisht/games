import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * Gambit at full motion, held still. Every stage on a page runs on the test
 * clock (`window.__motionClock`), so a spec can stop the board between two
 * frames and photograph it — and, more usefully, prove what the page around
 * the board does *not* do while the board is still telling a move: no captured
 * piece in the HUD before it reaches its tray, no result before the king falls.
 * Screenshots land in test-results/ to be looked at; nothing is compared
 * pixel for pixel, because no two GPUs draw the same pixels.
 */

type Clock = { freeze(): void; release(): void; step(ms: number): Promise<void> }
const freeze = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motionClock: Clock }).__motionClock.freeze())
const release = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motionClock: Clock }).__motionClock.release())
const step = (page: Page, ms: number) =>
  page.evaluate((ms) => (window as unknown as { __motionClock: Clock }).__motionClock.step(ms), ms)

const TURN = { w: 'White’s turn.', b: 'Black’s turn.' }

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext({ reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false }))
    localStorage.setItem('games-motion', 'full')
    localStorage.setItem('games-test-clock', 'on')
    // The first-game guide has its own spec (chess-guide.spec.ts).
    localStorage.setItem('games-guide-chess', 'done')
  })
  return page
}

/** Moves by keyboard, from the seat's own side of the board (see chess-online.spec). */
function keyboardPlayer(page: Page, seat: 'w' | 'b') {
  const board = page.getByRole('group', { name: '3D chessboard', exact: true })
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
    await expect(page.getByRole('heading', { name: TURN[seat], exact: true })).toBeVisible()
    await go(from)
    await page.keyboard.press('Enter')
    await expect(page.locator('.ch-session .ch-panel-copy')).toContainText(`on ${from}`)
    await go(to)
    await page.keyboard.press('Enter')
  }
}

async function seatedGame(browser: Browser, errors: string[]) {
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)
  await host.goto('/#/chess')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/chess\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await guest.goto(`/#/chess/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()
  await host.getByRole('button', { name: /Play as White/ }).click()
  await guest.getByRole('button', { name: /Play as Black/ }).click()
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()
  await expect(host.locator('.ch-canvas canvas')).toBeVisible()
  await expect(guest.locator('.ch-canvas canvas')).toBeVisible()
  return { host, guest }
}

test('a scholar’s mate is told in order: capture, tray, the king’s fall, then the result', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  const { host, guest } = await seatedGame(browser, errors)
  const white = keyboardPlayer(host, 'w'),
    black = keyboardPlayer(guest, 'b')
  for (const [mover, from, to, san] of [
    [white, 'e2', 'e4', 'e4'],
    [black, 'e7', 'e5', 'e5'],
    [white, 'f1', 'c4', 'Bc4'],
    [black, 'b8', 'c6', 'Nc6'],
    [white, 'd1', 'h5', 'Qh5'],
    [black, 'g8', 'f6', 'Nf6'],
  ] as const) {
    await mover(from, to)
    await expect(host.getByLabel('Move history')).toContainText(san)
    await expect(guest.getByLabel('Move history')).toContainText(san)
  }

  // The flip swings round the board and rises as it turns: hold it halfway.
  await expect(host.locator('.ch-session .ch-panel-copy')).not.toContainText('Making a move')
  await freeze(host)
  await host.getByRole('button', { name: 'Flip board' }).click()
  await step(host, 560)
  await host.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-flip-mid.png' })
  await step(host, 900)
  await host.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-flip-end.png' })
  await host.getByRole('button', { name: 'Flip board' }).click()
  await step(host, 1500)
  await release(host)

  // Both boards stop before the mating capture is sent.
  await freeze(guest)
  await freeze(host)
  await white('h5', 'f7')
  await expect(guest.getByLabel('Move history')).toContainText('Qxf7#')
  const capturedByWhite = guest.locator('.ch-player').filter({ hasText: 'Ann' }).locator('.ch-captured')
  const result = guest.getByRole('dialog', { name: 'Game result' })
  // The snapshot is here; the board has not moved, so neither has anything that waits on it.
  await guest.waitForTimeout(1500)
  await expect(capturedByWhite).toHaveCount(0)
  await expect(result).toHaveCount(0)

  // Mid-flight, then the knock.
  await step(guest, 240)
  await step(host, 240)
  await guest.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-capture-flight.png' })
  await step(guest, 220)
  await guest.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-capture-knock.png' })
  await expect(capturedByWhite).toHaveCount(0)

  // The pawn only shows by White's name once it has landed in the tray.
  let elapsed = 460
  while ((await capturedByWhite.count()) === 0 && elapsed < 4000) {
    await step(guest, 100)
    elapsed += 100
  }
  await expect(capturedByWhite).toHaveCount(1)
  expect(elapsed).toBeGreaterThan(700)
  await expect(result).toHaveCount(0)

  // The beaten king goes over; the winner's side gets the confetti.
  await step(guest, 900)
  await guest.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-mate-fall.png' })
  await step(host, 1500)
  await host.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-mate-confetti.png' })
  // Still frozen mid-celebration on the host: its result waits for its own board.
  await expect(host.getByRole('dialog', { name: 'Game result' })).toHaveCount(0)
  await release(guest)
  await release(host)
  await expect(result).toBeVisible()
  await expect(result).toContainText('White wins.')
  await expect(host.getByRole('dialog', { name: 'Game result' })).toContainText('CHECKMATE')
  await guest.screenshot({ path: 'test-results/chess-motion-result.png' })
  expect(errors).toEqual([])
  await host.context().close()
  await guest.context().close()
})

test('a rematch sends every piece home, and the board opens mid-move after a reload', async ({ browser }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  const { host, guest } = await seatedGame(browser, errors)
  const white = keyboardPlayer(host, 'w'),
    black = keyboardPlayer(guest, 'b')
  await white('e2', 'e4')
  await black('d7', 'd5')
  await white('e4', 'd5')
  await expect(guest.getByLabel('Move history')).toContainText('exd5')

  // Resign and rematch: the pieces, the tray included, fly home back ranks first.
  await guest.getByRole('button', { name: 'Resign', exact: true }).click()
  await guest.getByRole('button', { name: 'Resign game', exact: true }).click()
  await expect(host.getByRole('dialog', { name: 'Game result' })).toContainText('Black RESIGNED')
  await host.getByRole('button', { name: 'Rematch', exact: true }).click()
  await freeze(guest)
  await guest.getByRole('button', { name: 'Accept rematch', exact: true }).click()
  await expect(guest.getByRole('dialog', { name: 'Game result' })).toHaveCount(0)
  await expect(guest.getByLabel('Move history')).not.toContainText('exd5')
  await step(guest, 420)
  await guest.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-rematch.png' })
  await step(guest, 2000)
  await release(guest)

  // Seats swap on a rematch: the guest now has White.
  const guestWhite = keyboardPlayer(guest, 'w')
  await guestWhite('g1', 'f3')
  await expect(host.getByLabel('Move history')).toContainText('Nf3')
  await host.reload()
  await expect(host.getByLabel('Move history')).toContainText('Nf3')
  await expect(host.locator('.ch-canvas canvas')).toBeVisible()
  await host.locator('.ch-table').screenshot({ path: 'test-results/chess-motion-reload.png' })
  expect(errors).toEqual([])
  await host.context().close()
  await guest.context().close()
})
