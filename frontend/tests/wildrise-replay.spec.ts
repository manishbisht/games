import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/wildrise'
import { phaseDuration } from '@games/shared/wildrise/timing'
import type { Action, GameState, PlayerId } from '@games/shared/wildrise/types'
import type { Replay, ReplayFrame } from '@games/shared/protocol'

/**
 * A finished game of Wildrise, played back on the real board. A real room
 * throws real dice, so the replay's fetch is answered with a short game built
 * from the engine itself, late in the climb: Robin meets the snake on 88 and
 * slides to 48, Ash climbs 51 → 91, rolls one too many for the summit, and
 * then lands the three that takes it.
 *
 * What is asserted is the replay's contract: playing on into the next state
 * runs the board's own beats — the positions under the board count up hop by
 * hop with the token, and only jump a snake or a ladder when the token does —
 * at the replay's speed, and any other move of the playhead lands at once.
 * The table's own win dialog links here.
 */

const CODE = 'WRXRSE'

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

function opening(): GameState {
  const game = createGame({ playerCount: 2, names: ['Robin', 'Ash'], controls: ['human', 'casual'] })
  const squares: Record<string, number> = { red: 84, blue: 49 }
  return { ...game, players: game.players.map((p) => ({ ...p, position: squares[p.id] })) }
}

/**
 * Every state the room would have entered, with the gaps it would have left:
 * a moment before each roll, then each beat for as long as the room holds it.
 */
function scriptedGame(): ReplayFrame<GameState>[] {
  let at = Date.now() - 60_000,
    state = opening()
  const frames: ReplayFrame<GameState>[] = [{ at, state }]
  const enter = (action: Action) => {
    at += state.phase === 'ready' ? 900 : phaseDuration(state, false) + 300
    state = gameReducer(state, action)
    frames.push({ at, state })
  }
  for (const value of [4, 2, 5, 6, 2, 5, 3, 3]) {
    enter({ type: 'ROLL', value })
    enter({ type: 'DICE_SETTLED' })
    if (state.phase === 'moving') enter({ type: 'MOVE_DONE' })
    if (state.phase === 'transporting') enter({ type: 'TRANSPORT_DONE' })
    if (state.phase === 'won') break
    enter({ type: 'NEXT_TURN' })
  }
  return frames
}

const FRAMES = scriptedGame()
const replay = (): Replay<GameState> => ({
  game: 'wildrise',
  players: [
    { seat: 'p0', name: 'Robin' },
    { seat: 'p1', name: 'Ash', bot: { skill: 'casual' } },
  ],
  states: FRAMES,
  finished: true,
  expiresAt: Date.now() + 23.5 * 3_600_000,
})
/** The index of the first state matching `test`, at or after `from`. */
const find = (test: (state: GameState) => boolean, from = 0) =>
  FRAMES.findIndex((frame, index) => index >= from && test(frame.state))
const square = (index: number, id: PlayerId) => FRAMES[index].state.players.find((p) => p.id === id)!.position

test.beforeAll(() => {
  // The script is what the assertions below lean on; make sure it still says it.
  const last = FRAMES.at(-1)!.state
  expect(last.winner).toBe('blue')
  expect(FRAMES.some((frame) => frame.state.motion?.kind === 'snake')).toBe(true)
  expect(FRAMES.some((frame) => frame.state.motion?.kind === 'ladder')).toBe(true)
  expect(FRAMES.some((frame) => frame.state.events[0].kind === 'wait')).toBe(true)
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
  await page.goto(`/#/wildrise/replay/${CODE}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Ash' })).toBeVisible()
  await expect(page.locator('.wr-replay canvas')).toBeVisible()
  return errors
}

const slider = (page: Page) => page.getByRole('slider', { name: 'Replay position' }),
  position = (page: Page) => slider(page).evaluate((input) => Number((input as HTMLInputElement).value)),
  caption = (page: Page) => page.locator('.wr-replay-caption'),
  shown = (page: Page, id: PlayerId) => page.getByTestId(`wildrise-replay-${id}`).locator('strong')

test('the replay plays the whole game on the board, and every jump lands at once', async ({ page }) => {
  const errors = await openReplay(page)
  const last = FRAMES.length - 1
  await expect(slider(page)).toHaveAttribute('max', String(last))
  await expect(shown(page, 'red')).toHaveText('84')
  await expect(shown(page, 'blue')).toHaveText('49')
  // It starts on its own once the board has drawn.
  await page.getByRole('button', { name: '4×' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  const climb = find((s) => s.motion?.kind === 'ladder')
  await expect.poll(() => position(page), { timeout: 15_000, intervals: [50] }).toBeGreaterThanOrEqual(climb)
  await page.screenshot({ path: 'test-results/wildrise-replay-playing.png' })
  await expect.poll(() => position(page), { timeout: 30_000 }).toBe(last)
  await expect(caption(page)).toHaveText('Ash reaches 100 and wins.')
  await expect(shown(page, 'blue')).toHaveText('100', { timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/wildrise-replay-won.png' })

  // Every other move of the playhead lands straight away: the positions are
  // the state's, at once, not a walk there.
  await page.keyboard.press('Home')
  await expect(shown(page, 'red')).toHaveText('84')
  await expect(shown(page, 'blue')).toHaveText('49')
  const slid = find((s) => s.phase === 'settling' && s.currentPlayer === 0)
  await slider(page).fill(String(slid))
  expect(await position(page)).toBe(slid)
  await expect(shown(page, 'red')).toHaveText(String(square(slid, 'red')))
  await expect(caption(page)).toHaveText(FRAMES[slid].state.events[0].message)
  await page.screenshot({ path: 'test-results/wildrise-replay-scrubbed.png' })
  await page.keyboard.press('End')
  await expect(shown(page, 'blue')).toHaveText('100')
  await expect(shown(page, 'red')).toHaveText(String(square(last, 'red')))

  // At phone width the board and its positions still fit.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(caption(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: 'test-results/wildrise-replay-phone.png', fullPage: true })
  expect(errors).toEqual([])
})

test('playing into the next state runs the board’s own beats, at the replay’s speed', async ({ page }) => {
  const errors = await openReplay(page, { clock: true, theme: 'dark' })
  await page.waitForFunction(() => Boolean(window.__motionClock))
  await page.getByRole('button', { name: 'Pause' }).click()
  // Hold the board still; the page's own clock runs on.
  await page.evaluate(() => window.__motionClock!.freeze())

  // Robin's walk 84 → 88 at 1×: 190 ms a hop, as the live table walks it.
  const walk = find((s) => s.phase === 'moving')
  await slider(page).fill(String(walk - 1))
  await expect(shown(page, 'red')).toHaveText('84')
  await page.getByRole('button', { name: '1×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 3000, intervals: [40] }).toBe(walk)
  await page.getByRole('button', { name: 'Pause' }).click()
  expect(await position(page)).toBe(walk)
  // On the walk, but the token has not set off: nothing has moved yet.
  await expect(shown(page, 'red')).toHaveText('84')
  await step(page, 400)
  await expect(shown(page, 'red')).toHaveText('86')
  await page.screenshot({ path: 'test-results/wildrise-replay-walk.png' })
  await step(page, 400)
  await expect(shown(page, 'red')).toHaveText('88')

  // Into the slide: the token is only on 48 once the snake has let go of it.
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 3000, intervals: [40] }).toBe(walk + 1)
  await page.getByRole('button', { name: 'Pause' }).click()
  expect(FRAMES[walk + 1].state.motion?.kind).toBe('snake')
  await step(page, 900)
  await page.screenshot({ path: 'test-results/wildrise-replay-slide.png' })
  await expect(shown(page, 'red')).toHaveText('88')
  await step(page, 900)
  await expect(shown(page, 'red')).toHaveText('48')

  // Ash's climb at 2×: the 1.65 s ride is over in half of it.
  const climb = find((s) => s.motion?.kind === 'ladder')
  await slider(page).fill(String(climb - 1))
  await expect(shown(page, 'blue')).toHaveText('51')
  await page.getByRole('button', { name: '2×' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 3000, intervals: [40] }).toBe(climb)
  await page.getByRole('button', { name: 'Pause' }).click()
  await step(page, 500)
  await page.screenshot({ path: 'test-results/wildrise-replay-climb.png' })
  await expect(shown(page, 'blue')).toHaveText('51')
  await step(page, 400)
  await expect(shown(page, 'blue')).toHaveText('91')

  // A step while paused lands at once, frozen clock or not.
  await page.getByRole('button', { name: 'Step forward' }).click()
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(caption(page)).toHaveText(FRAMES[climb + 2].state.events[0].message)
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
    ...(bot ? { bot: { skill: 'casual' } } : {}),
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
          game: 'wildrise',
          visibility: 'private',
          status: 'finished',
          seatIds: ['p0', 'p1'],
          seats: { p0: seat('Robin'), p1: seat('Ash', true) },
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

test('the win dialog offers the replay', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('games-guest-name', 'Robin')
    localStorage.setItem('games-guide-wildrise', 'done')
  })
  await page.route(`**/api/rooms/${CODE}/replay**`, (route) => route.fulfill({ json: replay() }))
  const { joined } = await finishedRoom(page, FRAMES.at(-1)!.state)
  await page.goto(`/#/wildrise/room/${CODE}`)
  await joined
  const dialog = page.getByRole('dialog', { name: 'Ash wins!' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const link = dialog.getByRole('link', { name: 'Watch the replay' })
  await expect(link).toHaveAttribute('href', `#/wildrise/replay/${CODE}`)
  // The game's own dialog offers it, so the room page leaves its generic link out.
  await expect(page.locator('.room-replay-link')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/wildrise-replay-dialog.png' })
  await link.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Ash' })).toBeVisible()
  await expect(page.locator('.wr-replay canvas')).toBeVisible()
  expect(errors).toEqual([])
})
