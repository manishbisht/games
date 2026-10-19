import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PROTOCOL_VERSION } from '@games/shared/protocol'

/**
 * Gambit's replay, on the real board: a room's finished game played back from
 * its result dialog, and the same game from its permanent link, which needs no
 * room at all. The board proves what it shows through two attributes on the
 * view: `data-moves` (the moves in the state on screen) and
 * `data-presenting` (a move is still being told).
 */

const API = process.env.VITE_API_URL || 'http://127.0.0.1:8787'

type Clock = { freeze(): void; release(): void; step(ms: number): Promise<void> }
const freeze = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motionClock: Clock }).__motionClock.freeze())
const release = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motionClock: Clock }).__motionClock.release())
const step = (page: Page, ms: number) =>
  page.evaluate((ms) => (window as unknown as { __motionClock: Clock }).__motionClock.step(ms), ms)

async function prepare(page: Page, guestId = crypto.randomUUID(), clock = false) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(
    ({ guestId, clock }) => {
      localStorage.setItem('games-guest-id', guestId)
      localStorage.setItem('games-guest-name', 'Robin')
      localStorage.setItem('games-sound-chess', 'off')
      localStorage.setItem('games-motion', 'full')
      localStorage.setItem('games-guide-chess', 'done')
      if (clock) localStorage.setItem('games-test-clock', 'on')
    },
    { guestId, clock },
  )
  return guestId
}

/** A room against the easy bot, two moves each and resigned from a second socket, open on `page`. */
async function finishedGame(page: Page) {
  const guestId = await prepare(page)
  const created = await page.request.post(`${API}/api/rooms`, {
    data: {
      game: 'chess',
      visibility: 'private',
      name: 'Robin',
      guestId,
      seats: 2,
      bots: ['easy'],
      autoStart: true,
    },
  })
  expect(created.status()).toBe(201)
  const { code } = (await created.json()) as { code: string }
  await page.goto(`/#/chess/room/${code}`)
  await expect(page.getByRole('group', { name: '3D chessboard', exact: true })).toBeVisible()
  await page.evaluate(
    async ({ api, code, guestId, protocol }) => {
      type Room = { snapshot: { status: string; gameState: { turn: string; history: unknown[] } | null } }
      const ws = new WebSocket(`${api.replace(/^http/, 'ws')}/api/rooms/${code}`)
      await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
      const waitFor = (predicate: (room: Room) => boolean) =>
        new Promise<Room>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the room never got there')), 20_000)
          const check = (event: MessageEvent) => {
            const message = JSON.parse(event.data as string)
            if (message.type !== 'room' || !predicate(message)) return
            clearTimeout(timer)
            ws.removeEventListener('message', check)
            resolve(message)
          }
          ws.addEventListener('message', check)
        })
      const joined = waitFor((room) => room.snapshot.status === 'playing')
      ws.send(JSON.stringify({ type: 'join', protocol, name: 'Robin', guestId }))
      await joined
      for (const [index, [from, to]] of [
        ['e2', 'e4'],
        ['g1', 'f3'],
      ].entries()) {
        const answered = waitFor(
          (room) =>
            room.snapshot.gameState?.turn === 'w' &&
            room.snapshot.gameState.history.length === (index + 1) * 2,
        )
        ws.send(JSON.stringify({ type: 'action', action: { kind: 'move', from, to } }))
        await answered
      }
      const over = waitFor((room) => room.snapshot.status === 'finished')
      ws.send(JSON.stringify({ type: 'action', action: { kind: 'resign' } }))
      await over
      ws.close()
    },
    { api: API, code, guestId, protocol: PROTOCOL_VERSION },
  )
  return code
}

const view = (page: Page) => page.locator('.ch-replay')
const moves = (page: Page) => view(page).evaluate((el) => Number((el as HTMLElement).dataset.moves))
const position = (page: Page) =>
  page
    .getByRole('slider', { name: 'Replay position' })
    .evaluate((input) => Number((input as HTMLInputElement).value))

test('the result dialog leads to the replay, which plays on the board and lands where it is sent', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const code = await finishedGame(page)

  const dialog = page.getByRole('dialog', { name: 'Game result' })
  await expect(dialog).toBeVisible()
  const watch = dialog.getByRole('link', { name: 'Watch the replay' })
  expect(await watch.getAttribute('href')).toBe(`#/chess/replay/${code}`)
  // The room page leaves its own link out: the dialog has it.
  await expect(page.locator('.room-replay-link')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Copy permanent link' }).click()
  await expect(dialog.getByRole('button', { name: 'Copied!' })).toBeVisible()
  const permalink = await page.evaluate(() => navigator.clipboard.readText())
  expect(permalink).toMatch(
    /#\/chess\?moves=e2e4[a-h][1-8][a-h][1-8]g1f3[a-h][1-8][a-h][1-8]&end=resigned\.b&w=Robin&b=/,
  )
  await page.screenshot({ path: 'test-results/chess-replay-result-dialog.png' })

  await watch.click()
  await expect(page).toHaveURL(new RegExp(`#/chess/replay/${code}$`))
  await expect(view(page)).toBeVisible()
  await expect(view(page).locator('canvas')).toBeVisible()
  const last = Number(await page.getByRole('slider', { name: 'Replay position' }).getAttribute('max'))
  expect(last).toBeGreaterThanOrEqual(5)

  // It starts on its own, and the board follows the playhead move by move.
  await expect.poll(() => moves(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
  await page.screenshot({ path: 'test-results/chess-replay-playing.png' })
  await expect.poll(() => position(page), { timeout: 20_000 }).toBe(last)
  await expect(view(page)).not.toHaveAttribute('data-presenting', /.*/)
  expect(await moves(page)).toBe(4)
  // Robin played White and resigned: the line names the bot that won.
  await expect(view(page).locator('.ch-replay-result')).toHaveText(/^Resignation · .+ wins$/)
  await page.screenshot({ path: 'test-results/chess-replay-final.png' })

  // A scrub lands at once: no move is told between two states that aren't neighbours.
  await page.getByRole('slider', { name: 'Replay position' }).fill('2')
  await expect.poll(() => moves(page)).toBe(2)
  await expect(view(page)).not.toHaveAttribute('data-presenting', /.*/)
  await expect(view(page).locator('.ch-replay-result')).toHaveCount(0)
  await expect(view(page).locator('.ch-replay-move')).toContainText('1… ')
  await page.screenshot({ path: 'test-results/chess-replay-scrubbed.png' })
  await page.keyboard.press('Home')
  await expect.poll(() => moves(page)).toBe(0)
  await expect(view(page).locator('.ch-replay-move')).toHaveText('The opening position')

  expect(errors).toEqual([])
})

/** Fool's mate: the shortest game there is, and one that ends on the board rather than by resignation. */
const FOOLS_MATE = '/#/chess?moves=f2f3e7e5g2g4d8h4&w=Ann&b=Jules'

test('a permanent link plays the game back with no room behind it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page)
  await page.goto(FOOLS_MATE)
  await expect(page.getByRole('heading', { level: 1, name: 'Ann vs Jules' })).toBeVisible()
  await expect(page.getByText('Replay · Permanent link')).toBeVisible()
  await expect(page.getByText(/never expires/)).toBeVisible()
  await page.getByRole('button', { name: '4×' }).click()
  await expect.poll(() => position(page), { timeout: 15_000 }).toBe(4)
  await expect(view(page).locator('.ch-replay-result')).toHaveText('Checkmate · Jules wins')
  await expect(view(page).locator('.ch-replay-move')).toContainText('2… Qh4#')
  await page.screenshot({ path: 'test-results/chess-permalink-mate.png' })

  // The board's own copy button hands out the same link.
  await page.getByRole('button', { name: 'Copy permanent link' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(FOOLS_MATE.slice(1))

  // At phone width, in the dark: no sideways scroll, and the caption still says what happened.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => localStorage.setItem('games-appearance', 'dark'))
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.keyboard.press('End')
  await expect(view(page).locator('.ch-replay-result')).toHaveText('Checkmate · Jules wins')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/chess-permalink-phone-dark.png', fullPage: true })
  expect(errors).toEqual([])
})

test('a permanent link plays each move out on the board, frame by frame', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page, undefined, true)
  await page.goto(FOOLS_MATE)
  await expect(view(page).locator('canvas')).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Replay position' })
  // Pause, set down the position before the mate, then let it play into the mate.
  await page.getByRole('button', { name: /^(Pause|Play)$/ }).click()
  if (await page.getByRole('button', { name: 'Pause' }).isVisible())
    await page.getByRole('button', { name: 'Pause' }).click()
  await slider.fill('3')
  await expect.poll(() => moves(page)).toBe(3)
  await freeze(page)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  // The page's clock moves the playhead; the board's clock is held, so the mate waits at its first frame.
  await expect.poll(() => position(page), { timeout: 5000 }).toBe(4)
  await expect(view(page)).toHaveAttribute('data-presenting', 'true')
  await expect(view(page).locator('.ch-replay-result')).toHaveCount(0)
  await step(page, 200)
  await page.screenshot({ path: 'test-results/chess-permalink-queen-in-flight.png' })
  await expect(view(page).locator('.ch-replay-result')).toHaveCount(0)
  // Within the time the state stays on screen, the move has landed and the result is out.
  await step(page, 2400)
  await expect(view(page)).not.toHaveAttribute('data-presenting', /.*/)
  await expect(view(page).locator('.ch-replay-result')).toHaveText('Checkmate · Jules wins')
  await step(page, 1200)
  await page.screenshot({ path: 'test-results/chess-permalink-king-down.png' })
  await release(page)
  expect(errors).toEqual([])
})

test('a permanent link that is not a game says so', async ({ page }) => {
  await prepare(page)
  await page.goto('/#/chess?moves=e2e5')
  await expect(page.getByRole('heading', { name: 'That link looks wrong.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Gambit' })).toBeVisible()
})
