import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/estate'
import type { GameState } from '@games/shared/estate/types'

/**
 * Estate's motion, frame by frame. A real room rolls real dice, so these tests
 * stand a scripted room in for the server: the page's socket is routed to a
 * fake that deals exactly the table each moment needs — a roll onto a rented
 * street, a walk the room is already halfway through, a last player standing.
 * The page runs on the test clock, so every assertion lands on an exact frame.
 *
 * What is asserted is order, not pixels: the dice chip waits for the dice, the
 * balances wait for the token to land (and only then do the coins fly), a page
 * that joins mid-walk picks it up where the room is, and the winner's dialog
 * waits for the board's celebration. Screenshots go to test-results/.
 */

const CODE = 'ESMTN2'

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

/** Robin here, Jules across, Jules owning Old Town with three houses on Cedar Court. */
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
/** The room's `ROLL`, on dice the test chooses rather than the seed's. */
const rolling = (state: GameState, dice: [number, number]): GameState => ({
  ...state,
  dice,
  rollId: state.rollId + 1,
  phase: 'rolling',
  extraRoll: false,
})
/** What the room deals once it has held the roll's beat: the walk collapsed, the square resolved. */
function resolved(state: GameState): GameState {
  let next = gameReducer(state, { type: 'DICE_SETTLED' })
  while (next.phase === 'moving' && next.stepsRemaining > 0) next = gameReducer(next, { type: 'MOVE_STEP' })
  return next.phase === 'moving' ? gameReducer(next, { type: 'RESOLVE' }) : next
}

/**
 * The room, scripted: `deal` sends a state as the server would — with how long
 * ago, by the server's clock, it began — and `actions` collects what the page
 * asked for. `ready` resolves once the page has joined and no other socket of
 * its is still about (development React opens the room's socket twice).
 */
async function fakeRoom(page: Page) {
  let socket: WebSocketRoute | null = null,
    rejoin = false,
    resolve: () => void = () => {}
  const ready = new Promise<void>((done) => (resolve = done))
  const open = new Set<WebSocketRoute>(),
    joined = new Set<WebSocketRoute>(),
    actions: unknown[] = []
  const settle = () => {
    if (socket && !rejoin && [...open].every((ws) => joined.has(ws))) resolve()
  }
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}`), (ws) => {
    open.add(ws)
    ws.onClose(() => {
      open.delete(ws)
      if (!joined.has(ws) && socket && open.has(socket)) {
        rejoin = true
        void socket.close()
      }
      settle()
    })
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      const message = JSON.parse(String(raw))
      if (message.type === 'join') {
        joined.add(ws)
        socket = ws
        rejoin = false
        settle()
      }
      if (message.type === 'action') actions.push(message.action)
    })
  })
  const seat = (name: string) => ({ player: { name, isGuest: true }, connected: true, wantsRematch: false })
  return {
    ready,
    actions,
    deal(state: GameState, elapsed = 0) {
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
            timing: { now, since: now - elapsed },
          },
        }),
      )
    },
  }
}

/** Open the room on the test clock, frozen once the board is up. */
async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('games-test-clock', 'on')
    localStorage.setItem('games-motion', 'full')
    localStorage.setItem('games-guest-name', 'Robin')
    // The first-game guide has its own spec (estate-guide); here it would only sit over the frames.
    localStorage.setItem('games-guide-estate', 'done')
  })
  const room = await fakeRoom(page)
  await page.goto(`/#/estate/room/${CODE}`)
  await room.ready
  await page.waitForFunction(() => Boolean(window.__motionClock))
  await page.evaluate(() => window.__motionClock!.freeze())
  return { room, errors }
}

/** A balance as the sidebar shows it, without the change floating off it. */
const balance = (page: Page, player: number) =>
  page
    .locator(`[data-player="${player}"] .counted-money`)
    .evaluate((element) => element.firstChild?.textContent ?? '')
const flyingCoins = (page: Page) => page.locator('.estate-flying-coin').count()
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/estate-motion-${name}.png` })

test('the dice land before their chip, and rent waits for the token to reach the street', async ({
  page,
}) => {
  const { room, errors } = await open(page)
  const start = table()
  room.deal(start)
  await expect(page.getByRole('button', { name: /^Roll dice/ })).toBeEnabled()
  await step(page, 100)

  await page.getByRole('button', { name: /^Roll dice/ }).click()
  await expect.poll(() => room.actions).toEqual([{ type: 'ROLL' }])
  // Three squares onto Cedar Court, three houses on it: $180 to Jules.
  const roll = rolling(start, [1, 2]),
    after = resolved(roll)
  expect(after.players.map((p) => p.cash)).toEqual([1320, 1680])
  room.deal(roll)
  await expect(page.getByRole('button', { name: 'Rolling the dice…' })).toBeVisible()
  room.deal(after)
  await page.waitForTimeout(300)

  // Mid-throw: no chip yet, and nobody has paid anything.
  await step(page, 500)
  await shot(page, 'dice-in-the-air')
  await expect(page.locator('.dice-result')).toHaveCount(0)
  expect(await balance(page, 0)).toBe('$1,500')

  // The dice are down (960ms, the second die 70 after): the chip says what they say.
  await step(page, 600)
  await expect(page.locator('.dice-result')).toContainText('3')

  // The walk: dice 1180ms, three hops of 200, the last landing at 1780 and
  // settling until 2060. Until then the HUD holds the old balances.
  for (let at = 1200; at <= 2000; at += 100) {
    await step(page, 100)
    expect(await balance(page, 0)).toBe('$1,500')
    expect(await balance(page, 1)).toBe('$1,500')
    expect(await flyingCoins(page)).toBe(0)
  }
  await shot(page, 'landed-on-cedar-court')

  // Presented: the money moves, in the sidebar and across the board at once.
  await step(page, 100)
  await expect.poll(() => flyingCoins(page)).toBeGreaterThan(0)
  await step(page, 330)
  await shot(page, 'rent-coins-in-flight')
  await step(page, 500)
  await shot(page, 'rent-coins-landed')
  await expect.poll(() => balance(page, 0)).toBe('$1,320')
  await expect.poll(() => balance(page, 1)).toBe('$1,680')
  expect(errors).toEqual([])
})

test('a page that comes back mid-walk joins the walk where the room is', async ({ page }) => {
  const { room, errors } = await open(page)
  const start = table()
  room.deal(start)
  await expect(page.getByRole('button', { name: /^Roll dice/ })).toBeEnabled()
  await step(page, 100)
  // Away for the start of a roll: the first this page hears of it, the room is
  // 1.2s of dice and two of its 215ms squares into a five-square walk.
  const roll = rolling(start, [2, 3]),
    after = resolved(roll)
  room.deal(roll, 1200 + 2 * 215 + 60)
  await expect(page.getByRole('button', { name: 'Rolling the dice…' })).toBeVisible()
  room.deal(after)
  await page.waitForTimeout(200)
  await step(page, 50)
  // The dice are long down by the room's clock: no throw to sit through.
  await expect(page.locator('.dice-result')).toContainText('5')
  await shot(page, 'rejoined-mid-walk')
  // From the top, the dice and five hops would hold the board for 2460ms.
  // Joined on its third square, three hops and a settle are left.
  await step(page, 900)
  await expect(page.getByRole('button', { name: /^Buy for/ })).toBeVisible()
  await shot(page, 'rejoined-walk-landed')
  expect(errors).toEqual([])
})

test('the winner’s dialog waits for the board’s celebration', async ({ page }) => {
  const { room, errors } = await open(page)
  const start = table()
  room.deal(start)
  await expect(page.getByRole('button', { name: /^Roll dice/ })).toBeEnabled()
  await step(page, 100)
  const finished: GameState = {
    ...start,
    status: 'finished',
    winner: 0,
    phase: 'end',
    players: start.players.map((p) => (p.id === 1 ? { ...p, bankrupt: true, cash: 0 } : p)),
    eventId: start.eventId + 1,
    events: [
      { id: start.eventId + 1, text: 'Jules is bankrupt. Robin wins!', type: 'alert' },
      ...start.events,
    ],
  }
  room.deal(finished)
  // The spotlight, the camera coming round, three rounds of confetti.
  await step(page, 700)
  await shot(page, 'celebration')
  await expect(page.locator('.winner-dialog')).toHaveCount(0)
  await step(page, 900)
  await expect(page.locator('.winner-dialog')).toHaveCount(0)
  // It opens once the moment has had its time, and counts the tally up from nothing.
  await expect(page.locator('.winner-dialog')).toBeVisible({ timeout: 6000 })
  await expect(page.locator('.winner-stats strong').first()).toHaveText('$1,500', { timeout: 4000 })
  await shot(page, 'winner')
  expect(errors).toEqual([])
})
