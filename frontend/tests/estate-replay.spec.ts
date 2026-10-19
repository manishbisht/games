import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/estate'
import { ESTATE_PACING } from '@games/shared/estate/online'
import type { GameState } from '@games/shared/estate/types'
import type { Replay, ReplayFrame } from '@games/shared/protocol'

/**
 * Estate's replay, on the real board. A whole game of Estate is far too long
 * to play out here, so a scripted room stands in for the server — it deals a
 * table that has just been won — and the replay it links to is served from a
 * route: a short game built with the engine itself, timed the way the room
 * times one (a roll is held for its dice and walk; a decision is a player's).
 *
 * Asserted: the winner's dialog links the replay; playback walks the states
 * on its own; the players' cash waits for the board to land each roll even
 * though the playhead has moved on; a scrub or a step back lands at once; no
 * page errors. Screenshots go to test-results/.
 */

const CODE = 'ESRP42'

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

const settle = (state: GameState): GameState => {
  let next = gameReducer(state, { type: 'DICE_SETTLED' })
  while (next.phase === 'moving' && next.stepsRemaining > 0) next = gameReducer(next, { type: 'MOVE_STEP' })
  return next.phase === 'moving' ? gameReducer(next, { type: 'RESOLVE' }) : next
}
const roll = (state: GameState, dice: [number, number]): GameState => ({
  ...state,
  dice,
  rollId: state.rollId + 1,
  phase: 'rolling',
  extraRoll: false,
})
/** How long the room holds a roll of `steps` squares before dealing where it ends. */
const held = (steps: number) =>
  ESTATE_PACING.DICE_SETTLE_MS +
  steps * ESTATE_PACING.STEP_MS +
  ESTATE_PACING.LANDING_MS +
  ESTATE_PACING.MOTION_GRACE_MS

/** Robin and Jules, Jules owning Old Town with three houses on Cedar Court. */
function table(): GameState {
  const game = gameReducer(createGame(), {
    type: 'START',
    players: [
      { name: 'Robin', isBot: false },
      { name: 'Jules', isBot: false },
    ],
    mode: 'classic',
    seed: 7,
  })
  return {
    ...game,
    properties: {
      1: { owner: 1, level: 3, mortgaged: false },
      3: { owner: 1, level: 3, mortgaged: false },
    },
  }
}

/**
 * Robin rolls onto Cedar Court and pays Jules $180; Jules rolls onto the first
 * railroad and buys it; Robin goes bankrupt. Spectator view: the seed is zeroed.
 */
function game(): ReplayFrame<GameState>[] {
  const states: [number, GameState][] = []
  let at = 0
  const push = (wait: number, state: GameState) => {
    at += wait
    states.push([at, { ...state, seed: 0 }])
    return state
  }
  let state = push(0, table())
  state = push(1000, roll(state, [1, 2]))
  state = push(held(3), settle(state))
  state = push(1500, gameReducer(state, { type: 'END_TURN' }))
  state = push(900, roll(state, [2, 3]))
  state = push(held(5), settle(state))
  state = push(1200, gameReducer(state, { type: 'BUY' }))
  const last = state
  push(1800, {
    ...last,
    status: 'finished',
    winner: 1,
    phase: 'end',
    players: last.players.map((p) => (p.id === 0 ? { ...p, bankrupt: true, cash: 0 } : p)),
    eventId: last.eventId + 1,
    events: [{ id: last.eventId + 1, text: 'Robin is bankrupt. Jules wins!', type: 'alert' }, ...last.events],
  })
  return states.map(([at, state]) => ({ at: 1_760_000_000_000 + at, state }))
}

/** The room, scripted: it deals one state and says nothing else. */
async function fakeRoom(page: Page) {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}$`), (ws) => {
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      if (JSON.parse(String(raw)).type === 'join') socket = ws
    })
  })
  const seat = (name: string) => ({ player: { name, isGuest: true }, connected: true, wantsRematch: false })
  return {
    joined: () => socket !== null,
    deal(state: GameState) {
      const now = Date.now()
      socket!.send(
        JSON.stringify({
          type: 'room',
          you: { id: 'robin', seat: 'p0', isHost: true },
          snapshot: {
            protocol: 3,
            code: CODE,
            game: 'estate',
            visibility: 'private',
            status: state.status === 'finished' ? 'finished' : 'playing',
            seatIds: ['p0', 'p1'],
            seats: { p0: seat('Robin'), p1: seat('Jules') },
            gameState: state,
            timing: { now, since: now },
          },
        }),
      )
    },
  }
}

async function serveReplay(page: Page, states: ReplayFrame<GameState>[]) {
  const replay: Replay<GameState> = {
    game: 'estate',
    players: [
      { seat: 'p0', name: 'Robin' },
      { seat: 'p1', name: 'Jules', bot: { skill: 'standard' } },
    ],
    states,
    finished: true,
    expiresAt: Date.now() + 23.5 * 3_600_000,
  }
  await page.route(new RegExp(`/api/rooms/${CODE}/replay`), (route) =>
    route.fulfill({ json: replay, headers: { 'access-control-allow-origin': '*' } }),
  )
}

async function prepare(page: Page, { clock = false, theme = 'light' } = {}) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(
    ({ clock, theme }) => {
      if (clock) localStorage.setItem('games-test-clock', 'on')
      localStorage.setItem('games-motion', 'full')
      localStorage.setItem('games-appearance', theme)
      localStorage.setItem('games-guest-name', 'Robin')
      localStorage.setItem('games-guide-estate', 'done')
    },
    { clock, theme },
  )
  return errors
}

const position = (page: Page) =>
  page
    .getByRole('slider', { name: 'Replay position' })
    .evaluate((input) => Number((input as HTMLInputElement).value))
/** A player's cash as the replay's overlay shows it, without the change floating off it. */
const cash = (page: Page, name: string) =>
  page
    .locator('.estate-replay-players li', { hasText: name })
    .locator('.counted-money')
    .evaluate((element) => element.firstChild?.textContent ?? '')
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/estate-replay-${name}.png` })

test('the winner’s dialog links the replay, which plays, scrubs and steps on the board', async ({ page }) => {
  const errors = await prepare(page)
  const states = game()
  await serveReplay(page, states)
  const room = await fakeRoom(page)
  await page.goto(`/#/estate/room/${CODE}`)
  await expect.poll(room.joined).toBe(true)
  room.deal(states.at(-1)!.state)

  const link = page.getByRole('link', { name: 'Watch the replay' })
  await expect(link).toBeVisible({ timeout: 10_000 })
  expect(await link.getAttribute('href')).toBe(`#/estate/replay/${CODE}`)
  // The room page leaves its own link out: the game's dialog has it.
  await expect(link).toHaveCount(1)
  await shot(page, 'winner-dialog')
  await link.click()

  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Jules' })).toBeVisible()
  await expect(page.locator('.estate-replay canvas')).toBeVisible()
  const last = states.length - 1
  await expect(page.getByRole('slider', { name: 'Replay position' })).toHaveAttribute('max', String(last))
  // It starts on its own, once the board has drawn.
  await expect.poll(() => position(page), { timeout: 8000 }).toBeGreaterThan(0)
  await expect(page.locator('.estate-replay-players li')).toHaveCount(2)
  await shot(page, 'playing')

  // A scrub lands at once: Jules has bought the railroad.
  const slider = page.getByRole('slider', { name: 'Replay position' })
  await slider.fill(String(last - 1))
  const bought = states[last - 1].state.players
  await expect
    .poll(() => cash(page, 'Jules'), { timeout: 3000 })
    .toBe(`$${bought[1].cash.toLocaleString('en-US')}`)
  await expect(page.locator('.estate-replay-news')).toContainText('Jules bought Union Station')
  await shot(page, 'scrubbed')

  // A step back lands too: before the purchase, Jules still had it.
  await page.getByRole('button', { name: 'Step back' }).click()
  expect(await position(page)).toBe(last - 2)
  const before = states[last - 2].state.players
  await expect
    .poll(() => cash(page, 'Jules'), { timeout: 3000 })
    .toBe(`$${before[1].cash.toLocaleString('en-US')}`)

  // The end: the winner is named on the board's overlay.
  await page.keyboard.press('End')
  await expect(page.locator('.estate-replay-players li', { hasText: 'Jules' })).toContainText('Winner')
  await expect(page.locator('.estate-replay-players li', { hasText: 'Robin' })).toContainText('Bankrupt')
  await page.waitForTimeout(1200)
  await shot(page, 'final')
  expect(errors).toEqual([])
})

test('playback tells each roll on the board, and the cash waits for the token to land', async ({ page }) => {
  const errors = await prepare(page, { clock: true })
  const states = game()
  await serveReplay(page, states)
  await page.goto(`/#/estate/replay/${CODE}`)
  await expect(page.locator('.estate-replay canvas')).toBeVisible()
  await page.waitForFunction(() => Boolean(window.__motionClock))

  // Half speed, from the top, with the board's clock held: the playhead moves
  // on in real time, the board only as far as the test steps it.
  await page.getByRole('button', { name: '0.5×' }).click()
  await page.keyboard.press('Home')
  await page.evaluate(() => window.__motionClock!.freeze())
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  if ((await page.getByRole('button', { name: 'Pause' }).count()) === 0) await page.keyboard.press(' ')
  await expect.poll(() => position(page), { timeout: 6000 }).toBe(1)
  await page.evaluate(() => window.__motionClock!.step(500))
  await shot(page, 'dice-in-the-air')
  expect(await cash(page, 'Robin')).toBe('$1,500')

  // The rent arrives in the next state; the playhead reaches it while the
  // board is still mid-walk, and pausing there holds it.
  await expect.poll(() => position(page), { timeout: 8000 }).toBe(2)
  await page.keyboard.press(' ')
  await expect(page.getByRole('button', { name: /^Play/ })).toBeVisible()
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__motionClock!.step(500))
    expect(await cash(page, 'Robin')).toBe('$1,500')
    expect(await cash(page, 'Jules')).toBe('$1,500')
  }
  await shot(page, 'walking')
  // Landed: Robin pays Jules for the three houses on Cedar Court.
  await page.evaluate(() => window.__motionClock!.step(5000))
  await expect.poll(() => cash(page, 'Robin'), { timeout: 4000 }).toBe('$1,320')
  await expect.poll(() => cash(page, 'Jules'), { timeout: 4000 }).toBe('$1,680')
  await shot(page, 'rent-paid')
  await page.evaluate(() => window.__motionClock!.release())
  expect(errors).toEqual([])
})

for (const theme of ['light', 'dark'] as const)
  test(`replay screenshots, ${theme}`, async ({ page }) => {
    const errors = await prepare(page, { theme })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await serveReplay(page, game())
    await page.goto(`/#/estate/replay/${CODE}`)
    const slider = page.getByRole('slider', { name: 'Replay position' })
    await expect(page.locator('.estate-replay canvas')).toBeVisible()
    await slider.fill('5')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `test-results/estate-replay-desktop-${theme}.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `test-results/estate-replay-phone-${theme}.png`, fullPage: true })
    expect(errors).toEqual([])
  })
