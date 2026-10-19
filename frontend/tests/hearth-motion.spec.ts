import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/hearth'
import type { GameState } from '@games/shared/hearth/types'

/**
 * Hearth's motion, frame by frame. A real room rolls real dice, so these
 * tests stand a scripted room in for the server: the page's socket is routed
 * to a fake that deals exactly the table each moment needs — a capture lined
 * up, a piece one roll from home, a walk already half played. The page runs
 * on the test clock, so every assertion lands on an exact frame of the board.
 *
 * What is asserted is order, not pixels: the HUD must not learn what the
 * board has not shown yet, the result must wait for the board's celebration,
 * and a board that arrives mid-walk must pick the walk up where the room is.
 * Screenshots of the signature frames go to test-results/ for a person.
 */

const CODE = 'HHMTN2'
/** Red's walk 10 → 14 lands on blue's piece at progress 1: absolute space 21, not a star. */
const HOPS = [205, 150, 150, 195],
  LANDED = HOPS.reduce((a, b) => a + b),
  /** The victim's flight home ends here, and only then does the HUD put it in its nest. */
  VICTIM_HOME = LANDED + 70 + 890

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

/** A two-seat table — Robin here, a bot across — with pieces wherever the moment needs them. */
function table(progress: Record<string, number>, piecesPerPlayer = 2): GameState {
  const game = createGame({
    playerCount: 2,
    mode: 'custom',
    names: ['Robin', 'Jules'],
    controls: ['human', 'medium'],
    rules: { piecesPerPlayer },
  })
  return {
    ...game,
    startedAt: Date.now() - 60000,
    pieces: game.pieces.map((piece) => ({ ...piece, progress: progress[piece.id] ?? piece.progress })),
  }
}
const rolled = (state: GameState, value: number) =>
  gameReducer(gameReducer(state, { type: 'ROLL_START' }), { type: 'ROLL_RESULT', value })

/**
 * The room, scripted. `deal` sends a state as the server would — with how
 * long ago, on the server's clock, that state began — and `actions` collects
 * what the page asked for. `ready` resolves once the page has joined and no
 * other socket of its is still about.
 *
 * In development React opens the room's socket twice and closes the first.
 * If that close lands after the second socket has joined, `useRoom` forgets
 * it joined and keeps every action in its outbox; the room then drops the
 * live socket so the page reconnects and joins again, as a real room's
 * restart would make it.
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
  const seat = (name: string, bot?: boolean) => ({
    player: { name, isGuest: true },
    connected: true,
    wantsRematch: false,
    ...(bot ? { bot: { skill: 'medium' } } : {}),
  })
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
            game: 'hearth',
            visibility: 'private',
            status: state.phase === 'won' ? 'finished' : 'playing',
            seatIds: ['p0', 'p1'],
            seats: { p0: seat('Robin'), p1: seat('Jules', true) },
            gameState: state,
            timing: { now, since: now - elapsed },
          },
        }),
      )
    },
  }
}

/** Open the room on the test clock, frozen before the first state arrives. */
async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('games-test-clock', 'on')
    localStorage.setItem('games-motion', 'full')
    localStorage.setItem('games-guest-name', 'Robin')
  })
  const room = await fakeRoom(page)
  await page.goto(`/#/hearth-and-home/room/${CODE}`)
  await room.ready
  // The room preloads the board's code while it connects, the clock with it.
  await page.waitForFunction(() => Boolean(window.__motionClock))
  await page.evaluate(() => window.__motionClock!.freeze())
  return { room, errors }
}

/** The room's first state crosses in as a view transition; a screenshot during it shows the old page. */
const crossedIn = (page: Page) =>
  page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some((animation) =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition'),
        ),
  )

const card = (page: Page, id: string) => page.getByTestId(`player-${id}`),
  title = (page: Page) => page.locator('.hh-turn-title')

/**
 * Steps the board a frame at a time until `done` holds, checking `meanwhile`
 * on every frame before it — an ordering that has to hold frame by frame.
 */
async function stepUntil(page: Page, done: () => Promise<boolean>, meanwhile: () => Promise<void>) {
  for (let ms = 0; ms < 3000; ms += 1000 / 60) {
    if (await done()) return
    await meanwhile()
    await step(page, 1000 / 60)
  }
  throw new Error('the board never got there')
}
const label = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

test('the die lands before the HUD learns its number, and a capture lands before the nest fills', async ({
  page,
}) => {
  const { room, errors } = await open(page)
  const start = table({ 'red-0': 10, 'blue-0': 1 })
  room.deal(start)
  await expect(label(page, 'Roll dice')).toBeEnabled()
  await step(page, 50)

  // The roll: the room says "rolling", then — while the board is still frozen — the number.
  await label(page, 'Roll dice').click()
  await expect.poll(() => room.actions).toEqual([{ kind: 'roll' }])
  const rolling = gameReducer(start, { type: 'ROLL_START' }),
    choose = rolled(start, 4)
  room.deal(rolling)
  await expect(label(page, 'Rolling…')).toBeVisible()
  room.deal(choose)
  // The number has arrived, but the die has not been thrown: the HUD waits for it.
  await page.waitForTimeout(500)
  await expect(label(page, 'Rolling…')).toBeVisible()
  await step(page, 240)
  await page.screenshot({ path: 'test-results/hearth-motion-toss.png' })
  await expect(label(page, 'Rolling…')).toBeVisible()
  await step(page, 400)
  await expect(label(page, 'Choose a piece')).toBeVisible()
  await expect(page.locator('.hh-turn-subtitle')).toHaveText('You rolled 4. Make your move.')

  // The capture: red walks four squares onto blue's piece.
  expect(choose.legalMoves).toEqual([expect.objectContaining({ pieceId: 'red-0', captures: ['blue-0'] })])
  await page.getByRole('button', { name: 'Move piece 1', exact: true }).click()
  await expect.poll(() => room.actions.length).toBe(2)
  const moving = gameReducer(choose, { type: 'MOVE', pieceId: 'red-0' })
  room.deal(moving)
  await expect(label(page, 'On the way…')).toBeVisible()
  await expect(card(page, 'blue')).toContainText('1 on board')

  await step(page, 350)
  await page.screenshot({ path: 'test-results/hearth-motion-walk.png' })
  await step(page, LANDED + 35 - 350)
  await page.screenshot({ path: 'test-results/hearth-motion-hit.png' })
  // The hit has landed, but the victim is still on the board until it flies home.
  await expect(card(page, 'blue')).toContainText('1 on board')
  await step(page, 450)
  await page.screenshot({ path: 'test-results/hearth-motion-knocked-home.png' })
  await expect(card(page, 'blue')).toContainText('1 on board')
  await step(page, VICTIM_HOME - (LANDED + 35 + 450) + 40)
  await expect(card(page, 'blue')).toContainText('0 on board · 2 in nest')
  await expect(card(page, 'red')).toContainText('1 on board · 1 in nest')

  // The room moves on to Jules; the board follows once its beat is over.
  room.deal(gameReducer(moving, { type: 'ANIMATION_DONE' }))
  await step(page, 100)
  await expect(page.getByRole('heading', { name: 'Jules’s turn', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a piece comes home, and the result waits for the board to celebrate', async ({ page }) => {
  const { room, errors } = await open(page)
  // One piece each: red's last three squares win the game.
  const choose = rolled(table({ 'red-0': 54, 'blue-0': 30 }, 1), 3)
  // Robin has had a few seconds to look at the roll.
  room.deal(choose, 5000)
  await expect(label(page, 'Choose a piece')).toBeVisible()
  await step(page, 50)
  await page.getByRole('button', { name: 'Move piece 1', exact: true }).click()
  await expect.poll(() => room.actions.length).toBe(1)
  const moving = gameReducer(choose, { type: 'MOVE', pieceId: 'red-0' })
  const won = gameReducer(moving, { type: 'ANIMATION_DONE' })
  expect(won.winner).toBe('red')
  room.deal(moving)
  await expect(label(page, 'On the way…')).toBeVisible()
  // The room's next state arrives straight away — far ahead of the board,
  // which plays the rest of its walk a little faster to catch up.
  room.deal(won)

  await step(page, 250)
  await page.screenshot({ path: 'test-results/hearth-motion-home-hop.png' })
  // Long enough for the result to have shown, had it not waited for the board.
  await page.waitForTimeout(2000)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(card(page, 'red')).toContainText('0 / 1')
  await expect(title(page)).toHaveText('Robin’s turn')

  // Frame by frame: the piece settles into the centre and its pip fills, and
  // only after that does the table announce the win.
  await stepUntil(
    page,
    async () => (await card(page, 'red').textContent())!.includes('1 / 1'),
    async () => expect(await title(page).textContent()).toBe('Robin’s turn'),
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await stepUntil(
    page,
    async () => (await title(page).textContent()) === 'Robin wins!',
    async () => expect(await card(page, 'red').textContent()).toContain('1 / 1'),
  )
  await step(page, 450)
  await page.screenshot({ path: 'test-results/hearth-motion-confetti.png' })
  await expect(page.getByRole('dialog', { name: 'Robin wins!' })).toBeVisible()
  await page.screenshot({ path: 'test-results/hearth-motion-victory.png' })
  expect(errors).toEqual([])
})

test('a board that arrives mid-walk picks the walk up where the room is', async ({ page }) => {
  const { room, errors } = await open(page)
  const start = table({ 'red-0': 10, 'blue-0': 1 })
  const moving = gameReducer(rolled(start, 4), { type: 'MOVE', pieceId: 'red-0' })
  // The room started this walk 900ms ago: the hit is over, blue is in the air.
  const elapsed = LANDED + 200
  room.deal(moving, elapsed)
  // The board shows the table as the walk had it, not as the room will end it.
  await expect(card(page, 'blue')).toContainText('1 on board')
  await step(page, 16)
  await crossedIn(page)
  await page.screenshot({ path: 'test-results/hearth-motion-join.png' })
  // Played from the start, blue would land 1.66s from now; resumed, it lands in 0.76s.
  await step(page, VICTIM_HOME - elapsed - 80)
  await expect(card(page, 'blue')).toContainText('1 on board')
  await step(page, 120)
  await expect(card(page, 'blue')).toContainText('0 on board · 2 in nest')
  expect(errors).toEqual([])
})

test('a board that arrives after the walk is over simply lands it', async ({ page }) => {
  const { room, errors } = await open(page)
  const moving = gameReducer(rolled(table({ 'red-0': 10, 'blue-0': 1 }), 4), {
    type: 'MOVE',
    pieceId: 'red-0',
  })
  room.deal(moving, 5000)
  await expect(label(page, 'On the way…')).toBeVisible()
  await expect(card(page, 'blue')).toContainText('0 on board · 2 in nest')
  // Nothing replays: the piece never goes back on the board.
  for (let i = 0; i < 6; i++) {
    await step(page, 150)
    await expect(card(page, 'blue')).toContainText('0 on board · 2 in nest')
  }
  await crossedIn(page)
  await page.screenshot({ path: 'test-results/hearth-motion-landed.png' })
  expect(errors).toEqual([])
})
