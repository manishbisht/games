import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer, motionDuration } from '@games/shared/hearth'
import type { GameState } from '@games/shared/hearth/types'
import type { Replay, ReplayFrame } from '@games/shared/protocol'

/**
 * A finished game of Hearth & Home, played back on the real board. The game
 * is scripted rather than played — a real room rolls real dice — so the
 * replay's fetch is answered with a short game built from the engine itself:
 * Robin knocks Jules back to the nest, Jules cannot leave it, and Robin rolls
 * a six and a three to bring the last piece home.
 *
 * What is asserted is the replay's contract: playing moves into each next
 * state through the board's own beats (the HUD-like caption only learns a
 * roll once the die has landed) at the replay's speed, and any other move of
 * the playhead lands at once. The room's own result dialog links here.
 */

const CODE = 'HHRPY2'

interface Clock {
  freeze(): void
  release(): void
  step(ms: number): Promise<void>
}
declare global {
  interface Window {
    __motionClock?: Clock
  }
}
const step = (page: Page, ms: number) => page.evaluate((ms) => window.__motionClock!.step(ms), ms)

/** Red's 44 → 48 lands on blue's 35 (both absolute space 48, not a star): a capture. */
function opening(): GameState {
  const game = createGame({
    playerCount: 2,
    mode: 'custom',
    names: ['Robin', 'Jules'],
    controls: ['human', 'medium'],
    rules: { piecesPerPlayer: 1 },
  })
  const progress: Record<string, number> = { 'red-0': 44, 'blue-0': 35 }
  return {
    ...game,
    startedAt: Date.now() - 120_000,
    pieces: game.pieces.map((piece) => ({ ...piece, progress: progress[piece.id] ?? piece.progress })),
  }
}

/**
 * Every state the room would have entered, with the gaps it would have left:
 * a moment to think before each roll, the rattle, a moment to choose, each
 * walk as long as the room holds it.
 */
function scriptedGame(): ReplayFrame<GameState>[] {
  const frames: ReplayFrame<GameState>[] = []
  let at = Date.now() - 60_000,
    state = opening()
  const enter = (next: GameState, after: number) => {
    at += after
    state = next
    frames.push({ at, state })
  }
  frames.push({ at, state })
  for (const value of [4, 2, 6, 3]) {
    enter(gameReducer(state, { type: 'ROLL_START' }), 800)
    enter(gameReducer(state, { type: 'ROLL_RESULT', value }), 650)
    if (state.phase === 'pass') {
      enter(gameReducer(state, { type: 'NEXT_TURN' }), 1700)
      continue
    }
    enter(gameReducer(state, { type: 'MOVE', pieceId: state.legalMoves[0].pieceId }), 900)
    enter(gameReducer(state, { type: 'ANIMATION_DONE' }), motionDuration(state, false) + 300)
  }
  return frames
}

const FRAMES = scriptedGame()
const replay = (): Replay<GameState> => ({
  game: 'hearth',
  players: [
    { seat: 'p0', name: 'Robin' },
    { seat: 'p1', name: 'Jules', bot: { skill: 'medium' } },
  ],
  states: FRAMES,
  finished: true,
  expiresAt: Date.now() + 23.5 * 3_600_000,
})
/** The index of the first state matching `test`, at or after `from`. */
const find = (test: (state: GameState) => boolean, from = 0) =>
  FRAMES.findIndex((frame, index) => index >= from && test(frame.state))
const message = (index: number) => FRAMES[index].state.events[0].message

test.beforeAll(() => {
  // The script is what the assertions below lean on; make sure it still says it.
  const last = FRAMES.at(-1)!.state
  expect(last.winner).toBe('red')
  expect(FRAMES.some((frame) => frame.state.motion?.captures.length)).toBe(true)
  expect(FRAMES.some((frame) => frame.state.phase === 'pass')).toBe(true)
})

async function openReplay(page: Page, options: { clock?: boolean; theme?: 'light' | 'dark' } = {}) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(
    ({ clock, theme }) => {
      if (clock) localStorage.setItem('games-test-clock', 'on')
      localStorage.setItem('games-motion', 'full')
      localStorage.setItem('games-appearance', theme)
    },
    { clock: Boolean(options.clock), theme: options.theme ?? 'light' },
  )
  await page.route(`**/api/rooms/${CODE}/replay**`, (route) =>
    route.fulfill({ json: replay(), headers: { 'cache-control': 'no-store' } }),
  )
  await page.goto(`/#/hearth-and-home/replay/${CODE}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Jules' })).toBeVisible()
  await expect(page.locator('.hh-replay canvas')).toBeVisible()
  return errors
}

const slider = (page: Page) => page.getByRole('slider', { name: 'Replay position' }),
  position = (page: Page) => slider(page).evaluate((input) => Number((input as HTMLInputElement).value)),
  caption = (page: Page) => page.locator('.hh-replay-caption')

test('the replay plays the whole game on the board, and every jump lands at once', async ({ page }) => {
  const errors = await openReplay(page)
  const last = FRAMES.length - 1
  await expect(slider(page)).toHaveAttribute('max', String(last))
  // It starts on its own once the board has drawn, from the opening table.
  await expect(caption(page)).toContainText(message(0))
  await page.getByRole('button', { name: '4×' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  // Mid-game, for a person to look at.
  await expect
    .poll(() => position(page), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(find((s) => s.phase === 'moving'))
  await page.screenshot({ path: 'test-results/hearth-replay-playing.png' })
  await expect.poll(() => position(page), { timeout: 20_000 }).toBe(last)
  // The last move plays out too: the piece comes home, then the table says who won.
  await expect(caption(page)).toContainText('Robin wins!', { timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/hearth-replay-won.png' })

  // Every other move of the playhead lands straight away.
  await page.keyboard.press('Home')
  await expect(caption(page)).toContainText(message(0))
  const capture = find((s) => Boolean(s.motion?.captures.length))
  await slider(page).fill(String(capture))
  expect(await position(page)).toBe(capture)
  await expect(caption(page)).toContainText('Robin captured Jules! Back to the nest.')
  await expect(caption(page)).toContainText(`Turn ${FRAMES[capture].state.turn}`)
  await page.screenshot({ path: 'test-results/hearth-replay-scrubbed.png' })
  await page.keyboard.press('ArrowRight')
  await expect(caption(page)).toContainText(message(capture + 1))
  await page.keyboard.press('End')
  await expect(caption(page)).toContainText('Robin wins!')

  // At phone width the board and its caption still fit.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(caption(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/hearth-replay-phone.png', fullPage: true })
  expect(errors).toEqual([])
})

test('playing into the next state runs the board’s own beats, at the replay’s speed', async ({ page }) => {
  const errors = await openReplay(page, { clock: true, theme: 'dark' })
  await page.waitForFunction(() => Boolean(window.__motionClock))
  await expect(caption(page)).toContainText(message(0))
  // Hold the board still; the page's own clock runs on.
  await page.evaluate(() => window.__motionClock!.freeze())

  // Robin's first rattle, then the toss that lands on a 4.
  const rattle = find((s) => s.phase === 'rolling')
  expect(FRAMES[rattle + 1].state.phase).toBe('choose')
  await slider(page).fill(String(rattle))
  await expect(caption(page)).toContainText(message(rattle))
  await page.getByRole('button', { name: '1×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 3000, intervals: [40] }).toBe(rattle + 1)
  await page.getByRole('button', { name: 'Pause' }).click()
  expect(await position(page)).toBe(rattle + 1)
  // The page is on the roll, but the die is still in the air: nobody has been told the number.
  await expect(caption(page)).toContainText(message(rattle))
  await step(page, 450)
  await page.screenshot({ path: 'test-results/hearth-replay-toss.png' })
  await expect(caption(page)).toContainText(message(rattle))
  await step(page, 200)
  await expect(caption(page)).toContainText('Robin rolled a 4.')

  // Jules's rattle at 2×: the same toss in half the time.
  const julesRattle = find((s) => s.phase === 'rolling' && s.currentPlayer === 1)
  expect(FRAMES[julesRattle + 1].state.phase).toBe('pass')
  await slider(page).fill(String(julesRattle))
  await expect(caption(page)).toContainText(message(julesRattle))
  await page.getByRole('button', { name: '2×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 3000, intervals: [40] }).toBe(julesRattle + 1)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(caption(page)).toContainText(message(julesRattle))
  await step(page, 250)
  await expect(caption(page)).toContainText(message(julesRattle))
  await step(page, 80)
  await expect(caption(page)).toContainText(message(julesRattle + 1))

  // A step while paused lands at once, frozen clock or not.
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(caption(page)).toContainText(message(julesRattle + 2))
  await page.evaluate(() => window.__motionClock!.release())
  expect(errors).toEqual([])
})

/** Just enough of a room to deal one finished table to the page. */
async function finishedRoom(page: Page, state: GameState) {
  let resolve: () => void = () => {}
  const joined = new Promise<void>((done) => (resolve = done))
  const seat = (name: string, bot?: boolean) => ({
    player: { name, isGuest: true },
    connected: true,
    wantsRematch: false,
    ...(bot ? { bot: { skill: 'medium' } } : {}),
  })
  const deal = (ws: WebSocketRoute) => {
    const now = Date.now()
    ws.send(
      JSON.stringify({
        type: 'room',
        you: { id: 'robin', seat: 'p0', isHost: true },
        snapshot: {
          protocol: 3,
          code: CODE,
          game: 'hearth',
          visibility: 'private',
          status: 'finished',
          seatIds: ['p0', 'p1'],
          seats: { p0: seat('Robin'), p1: seat('Jules', true) },
          gameState: state,
          timing: { now, since: now - 5000 },
        },
      }),
    )
  }
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}`), (ws) => {
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      const message = JSON.parse(String(raw))
      if (message.type !== 'join') return
      deal(ws)
      resolve()
    })
  })
  // Wrapped: an async function handing back a bare promise would wait on it.
  return { joined }
}

test('the result dialog offers the replay', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('games-guest-name', 'Robin')
    localStorage.setItem('games-guide-hearth', 'done')
  })
  await page.route(`**/api/rooms/${CODE}/replay**`, (route) => route.fulfill({ json: replay() }))
  const { joined } = await finishedRoom(page, FRAMES.at(-1)!.state)
  await page.goto(`/#/hearth-and-home/room/${CODE}`)
  await joined
  const dialog = page.getByRole('dialog', { name: 'Robin wins!' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const link = dialog.getByRole('link', { name: 'Watch the replay' })
  await expect(link).toHaveAttribute('href', `#/hearth-and-home/replay/${CODE}`)
  // The game's own dialog offers it, so the room page leaves its generic link out.
  await expect(page.locator('.room-replay-link')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/hearth-replay-dialog.png' })
  await link.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Jules' })).toBeVisible()
  await expect(page.locator('.hh-replay canvas')).toBeVisible()
  expect(errors).toEqual([])
})
