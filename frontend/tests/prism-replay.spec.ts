import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { getAdapter } from '@games/shared/online'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { Replay, ReplayFrame } from '@games/shared/protocol'
import type { GameState } from '@games/shared/prism/types'

/**
 * A finished Prism round, played back. No server: the round is played out
 * here by the game's own adapter and bots on a seeded random, every state kept
 * as the spectator's view the room would have logged, and the replay endpoint
 * answers with it. The room that links to it is a scripted socket showing
 * that same round, finished.
 *
 * What is asserted: the table is the spectator's (every seat a fan of backs,
 * counted), playback tells each next state the way the live table does — the
 * table is busy, and what it shows trails the state, until the card lands —
 * and a scrub, a step or a jump lands at once. Screenshots are for looking at.
 */
declare global {
  interface Window {
    __motionClock?: { freeze(): void; release(): void; step(ms: number): Promise<void> }
  }
}

const CODE = 'PRZM34'
const NAMES = ['Robin', 'Jules']
/** The room's pacing between two states: a bot's think and its card's flight. */
const GAP_MS = 2000

/** A small, fast, seedable stand-in for `Math.random` (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One round, two seats, played to the end by the bots — every state as nobody's view. */
function playRound() {
  const adapter = getAdapter('prism')!
  const seats = adapter.seatIds(NAMES.length)
  const ctx = { random: seeded(20261019), now: Date.now() }
  let state = adapter.create(
    seats.map((id, index) => ({ id, name: NAMES[index] })),
    adapter.validateOptions(undefined),
    ctx,
  ) as GameState
  const start = Date.now() - 10 * 60_000
  const states: ReplayFrame<GameState>[] = [{ at: start, state: adapter.view(state, null) as GameState }]
  for (let guard = 0; guard < 1000 && !adapter.isFinished(state); guard++) {
    const [seat] = adapter.waitingOn(state, seats)
    const next = adapter.bots!.decide(state, seat, seats, 'hard', ctx) as GameState
    if (next === state) break
    state = next
    states.push({ at: start + states.length * GAP_MS, state: adapter.view(state, null) as GameState })
  }
  expect(adapter.isFinished(state)).toBe(true)
  const replay: Replay<GameState> = {
    game: 'prism',
    players: seats.map((seat, index) => ({
      seat,
      name: NAMES[index],
      ...(index ? { bot: { skill: 'hard' } } : {}),
    })),
    states,
    finished: true,
    expiresAt: Date.now() + 23 * 3_600_000,
  }
  return { replay, final: state, seats }
}

const round = playRound()
const last = round.replay.states.length - 1
const sequenceAt = (index: number) => String(round.replay.states[index].state.sequence)

async function prepare(page: Page, errors: string[], options: { clock?: boolean } = {}) {
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript((clock) => {
    localStorage.setItem('games-guest-id', crypto.randomUUID())
    localStorage.setItem('games-guest-name', 'Robin')
    localStorage.setItem('games-motion', 'full')
    localStorage.setItem('games-guide-prism', 'done')
    localStorage.setItem('games-sound-prism', 'off')
    if (clock) localStorage.setItem('games-test-clock', 'on')
  }, Boolean(options.clock))
  await page.route(`**/api/rooms/${CODE}/replay**`, (route) => route.fulfill({ json: round.replay }))
}

const slider = (page: Page) => page.getByRole('slider', { name: 'Replay position' })
const position = (page: Page) => slider(page).evaluate((input) => Number((input as HTMLInputElement).value))
const table = (page: Page) => page.locator('.pr-replay')
const busy = (page: Page) => page.locator('.pr-replay[aria-busy="true"]')
const seat = (page: Page, player: number) => page.locator(`.pr-replay .pr-opponent[data-player="${player}"]`)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/prism-replay-${name}.png` })

/** Pauses wherever playback has got to: it starts by itself once the table has drawn a frame. */
async function pause(page: Page) {
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Play/ })).toBeVisible()
}

test('the round plays back at the spectator’s table, and every jump lands at once', async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = []
  await prepare(page, errors)
  await page.goto(`/#/prism/replay/${CODE}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Robin vs Jules' })).toBeVisible()
  await expect(table(page).locator('canvas')).toBeVisible()
  expect(Number(await slider(page).getAttribute('max'))).toBe(last)

  // It starts by itself, and the next state is told, not cut to: the table is
  // busy while the card is in the air, then shows the state it was handed.
  await page.getByRole('button', { name: '2×' }).click()
  await expect.poll(() => position(page), { timeout: 15000 }).toBeGreaterThan(0)
  await expect(busy(page)).toHaveCount(1, { timeout: 10000 })
  await shot(page, '1-playing')
  await pause(page)
  const at = await position(page)
  await expect(busy(page)).toHaveCount(0, { timeout: 10000 })
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(at))

  // Nobody's hand is shown, and every seat is counted.
  for (const [player] of NAMES.entries()) {
    const held = round.replay.states[at].state.players[player].hand.length
    await expect(seat(page, player)).toHaveAttribute(
      'aria-label',
      new RegExp(`^${NAMES[player]}, ${held} cards?`),
    )
  }
  expect(
    round.replay.states.every((frame) =>
      frame.state.players.every((p) => p.hand.every((c) => c.id.startsWith('hidden-'))),
    ),
  ).toBe(true)

  // A scrub, a step and a jump each land at once: nothing in the air, the table already there.
  const middle = Math.floor(last / 2)
  await slider(page).fill(String(middle))
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(middle))
  await expect(busy(page)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(middle + 1))
  await expect(busy(page)).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(middle - 1))
  await expect(busy(page)).toHaveCount(0)
  await shot(page, '2-scrubbed')

  // The end: the winner is named once the last card is down.
  await page.keyboard.press('End')
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(last))
  const winner = NAMES[round.final.winner!]
  await expect(page.locator('.pr-replay-result')).toContainText(`${winner} wins!`)
  await expect(seat(page, round.final.winner!)).toHaveAttribute('aria-label', /, 0 cards, winner$/)
  await shot(page, '3-end')

  // And from the start again.
  await page.keyboard.press('Home')
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(0))
  await expect(page.locator('.pr-replay-result')).toHaveCount(0)
  for (const [player] of NAMES.entries())
    await expect(seat(page, player)).toHaveAttribute('aria-label', /, 7 cards/)

  // A phone: no sideways scroll, the table still in the stage.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(table(page).locator('canvas')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.keyboard.press('End')
  await page.screenshot({ path: 'test-results/prism-replay-4-phone.png', fullPage: true })
  expect(errors).toEqual([])
})

test('held on the test clock, a played state is told card by card', async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = []
  await prepare(page, errors, { clock: true })
  await page.goto(`/#/prism/replay/${CODE}`)
  await expect(table(page).locator('canvas')).toBeVisible()
  await pause(page)
  // Slow, so the page's own clock leaves the frozen table time to be stepped.
  await page.getByRole('button', { name: '0.5×' }).click()

  // A state that follows with a card thrown onto the pile.
  const target = round.replay.states.findIndex(
    (frame, index) =>
      index > 0 &&
      frame.state.events.some(
        (e) => e.id > round.replay.states[index - 1].state.sequence && e.kind === 'play',
      ),
  )
  expect(target).toBeGreaterThan(0)
  await slider(page).fill(String(target - 1))
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(target - 1))
  const before = await page
    .locator('.pr-replay .pr-pile-name', { hasText: 'IN PLAY' })
    .locator('small')
    .textContent()

  await page.waitForFunction(() => Boolean(window.__motionClock))
  await page.evaluate(() => window.__motionClock!.freeze())
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  // The page moves on in its own time; the table holds until stepped.
  await expect.poll(() => position(page), { timeout: 10000 }).toBe(target)
  await expect(busy(page)).toHaveCount(1)
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(target - 1))
  await page.evaluate(() => window.__motionClock!.step(250))
  await shot(page, '5-in-flight')
  // Still in the air: the pile has not taken it yet.
  await expect(page.locator('.pr-replay .pr-pile-name', { hasText: 'IN PLAY' }).locator('small')).toHaveText(
    before!,
  )
  for (let i = 0; i < 20 && (await busy(page).count()); i++)
    await page.evaluate(() => window.__motionClock!.step(200))
  await expect(table(page)).toHaveAttribute('data-sequence', sequenceAt(target))
  await shot(page, '6-landed')
  await pause(page)
  expect(errors).toEqual([])
})

test('the round’s result links to its replay', async ({ page }) => {
  const errors: string[] = []
  await prepare(page, errors)
  const { final, seats } = round
  const adapter = getAdapter('prism')!
  const seatInfo = (index: number) => ({
    player: { name: NAMES[index], isGuest: true },
    connected: true,
    wantsRematch: false,
    ...(index ? { bot: { skill: 'hard' } } : {}),
  })
  const now = Date.now()
  const snapshot = {
    protocol: PROTOCOL_VERSION,
    code: CODE,
    game: 'prism',
    visibility: 'private',
    status: 'finished',
    seatIds: seats,
    seats: Object.fromEntries(seats.map((id, index) => [id, seatInfo(index)])),
    spectators: 0,
    gameState: adapter.view(final, seats[0]),
    timing: { now, since: now - 60_000 },
  }
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}`), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      const message = JSON.parse(String(raw)) as { type: string }
      if (message.type === 'join')
        ws.send(
          JSON.stringify({
            type: 'room',
            snapshot,
            you: { id: 'guest:robin', seat: seats[0], isHost: true },
          }),
        )
    })
  })
  await page.goto(`/#/prism/room/${CODE}`)
  const result = page.getByRole('dialog', { name: 'Round result' })
  await expect(result).toBeVisible({ timeout: 20000 })
  // The room's own link stays out of the way: the result offers it.
  await expect(page.locator('.room-replay-link')).toHaveCount(0)
  const link = result.getByRole('link', { name: 'Watch the replay' })
  await expect(link).toHaveAttribute('href', `#/prism/replay/${CODE}`)
  await page.screenshot({ path: 'test-results/prism-replay-0-result.png' })
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/prism/replay/${CODE}$`))
  await expect(table(page).locator('canvas')).toBeVisible()
  expect(errors).toEqual([])
})
