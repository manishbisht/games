import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * The smoke run: each game played a good way in, against the seats the server
 * plays. The rest of the suite proves a table is dealt and a bot's first turn
 * arrives; this one keeps going — rounds of buying in Estate, pieces leaving
 * the nest in Hearth, a hand played down to a Prism call, an opening against
 * the chess bot — and fails on anything the browser reports along the way: a
 * page error, a console error, a request that failed or came back 4xx/5xx.
 *
 * Nothing here is seeded, because nothing here is decided by this browser. So
 * the tests read what the room offers and take it, rather than scripting a
 * game move by move. Run with `npm run test:smoke`; it is left out of the
 * default suite for taking a few minutes on top of it.
 */

const ROOM = /\/room\/[A-Z2-9]{6}$/

/**
 * Whether `locator` is on the page and enabled, answered now. `isEnabled()`
 * alone waits for the element to exist — and a control that renames or
 * unmounts itself between phases (Hearth's die becomes "Choose a piece") would
 * hold a polling loop for as long as the game holds the phase.
 */
const enabledNow = async (locator: Locator) =>
  (await locator.count()) > 0 && (await locator.first().isEnabled())

/** Every socket frame the page sends or receives, kept for a failure's attachment. */
let socketLog: string[] = []
const stamp = () => new Date().toISOString().slice(11, 23)

/** Everything the page complains about, to be asserted empty at the end. */
function watch(page: Page) {
  const problems: string[] = []
  page.on('websocket', (socket) => {
    socketLog.push(`${stamp()} open ${socket.url()}`)
    socket.on('framesent', (frame) => socketLog.push(`${stamp()} sent ${String(frame.payload).slice(0, 80)}`))
    socket.on('framereceived', (frame) => {
      const payload = String(frame.payload)
      const phase = payload.match(/"phase":"([a-z]+)"/)?.[1] ?? ''
      const current = payload.match(/"currentPlayer":(\d+)/)?.[1] ?? ''
      socketLog.push(`${stamp()} received ${payload.slice(0, 24)}… phase=${phase} current=${current}`)
    })
    socket.on('close', () => socketLog.push(`${stamp()} close`))
  })
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    if (!/fonts\.g/.test(request.url())) problems.push(`request failed: ${request.url()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !/fonts\.g/.test(response.url()))
      problems.push(`http ${response.status()}: ${response.url()}`)
  })
  return problems
}

test.beforeEach(async ({ page }) => {
  socketLog = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

// eslint-disable-next-line no-empty-pattern -- Playwright wants a fixture pattern here, and none is needed.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && socketLog.length)
    await testInfo.attach('socket-frames', { body: socketLog.join('\n'), contentType: 'text/plain' })
})

test('the collection lists five games, and every old link still lands', async ({ page }) => {
  const problems = watch(page)
  await page.goto('/#/')
  await expect(page.getByRole('link', { name: /^Play / })).toHaveCount(5)
  for (const [from, to] of [
    ['Ludo', 'hearth-and-home'],
    ['Hearth', 'hearth-and-home'],
    ['Monopoly', 'estate'],
    ['Gambit', 'chess'],
    ['uno', 'prism'],
    ['snakes-and-ladders', 'wildrise'],
  ]) {
    await page.goto(`/#/${from}`)
    await expect(page).toHaveURL(`/#/${to}`)
  }
  await page.goto('/#/does-not-exist')
  await expect(page).toHaveURL('/#/')
  expect(problems).toEqual([])
})

test('estate: a table of two plays several rounds of rolling, buying and passing the turn', async ({
  page,
}) => {
  test.setTimeout(180000)
  const problems = watch(page)
  await page.goto('/#/estate')
  await page.getByRole('button', { name: 'Start game' }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByRole('button', { name: 'Remove player' }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(ROOM, { timeout: 30000 })
  await expect(page.getByText('Jules').first()).toBeVisible({ timeout: 30000 })

  // The one button carries the whole turn: roll, buy, roll again, end turn —
  // and reads as the bot's while the seat the room plays is taking its turn.
  const primary = page.locator('.roll-button')
  const card = page.getByRole('button', { name: 'Let’s see what’s next' })
  const latest = page.locator('.activity-event').first()
  const label = async () => (await primary.innerText()).replace(/\s*SPACE\s*$/, '').trim()
  const taken: string[] = []
  const deadline = Date.now() + 100000
  while (taken.length < 16 && Date.now() < deadline) {
    if ((await card.isVisible()) && (await card.isEnabled())) {
      await card.click()
      await expect(card).toBeHidden()
      taken.push('card')
      continue
    }
    const action = await label()
    // Selling and mortgaging are covered where the rules live; stop short of them.
    if (action.startsWith('Resolve payment')) break
    if (await primary.isEnabled()) {
      const event = await latest.innerText().catch(() => '')
      await primary.click()
      // Accepted means the room said something about it: a new event, or a new offer.
      await expect
        .poll(
          async () => (await latest.innerText().catch(() => '')) !== event || (await label()) !== action,
          {
            timeout: 30000,
          },
        )
        .toBe(true)
      taken.push(action)
      continue
    }
    if (action.startsWith('Buy for')) {
      await page.getByRole('button', { name: 'Pass', exact: true }).click()
      taken.push('pass')
      continue
    }
    await expect(primary).not.toHaveText(action, { timeout: 30000 })
  }
  test.info().annotations.push({ type: 'actions', description: taken.join(' → ') })
  // Several turns of ours, which means the bot's turns came and went between them.
  expect(taken.filter((action) => action === 'End turn').length).toBeGreaterThanOrEqual(3)
  expect(taken.filter((action) => action.startsWith('Roll')).length).toBeGreaterThanOrEqual(4)
  await page.screenshot({ path: 'test-results/smoke-estate.png', fullPage: true })
  expect(problems).toEqual([])
})

test('hearth: a quick table of two rolls and moves through a dozen turns', async ({ page }) => {
  test.setTimeout(180000)
  const problems = watch(page)
  await page.goto('/#/hearth-and-home')
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByRole('button', { name: 'Quick', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(ROOM, { timeout: 30000 })

  // By class, not name: the button reads "Roll dice" only while the die is
  // waiting, and "Choose a piece" once a roll wants one — the same element.
  const roll = page.locator('.hh-roll-button')
  const move = page.locator('button[aria-label^="Move piece"]:enabled').first()
  // With motion reduced, a roll and its move can come and go between two
  // polls of the button — but every one of them leaves a line in the feed.
  const feed = page.locator('.hh-event-feed')
  const offered = async () => (await move.count()) > 0 || (await enabledNow(roll))
  let rolls = 0
  let moves = 0
  const deadline = Date.now() + 100000
  while (rolls < 12 && Date.now() < deadline) {
    // Whatever the room offers next: a piece to move, the die, or a wait while
    // the seat it plays takes its turn.
    await expect.poll(offered, { timeout: 40000 }).toBe(true)
    const before = await feed.innerText()
    // A six turns the die into a choice of piece before a click can land on
    // it; a click that loses that race is simply not counted.
    if (await move.count()) {
      if (
        await move.click({ timeout: 5000 }).then(
          () => true,
          () => false,
        )
      )
        moves++
    } else if (
      await roll.click({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
    )
      rolls++
    await expect
      .poll(async () => (await feed.innerText()) !== before || (await offered()), { timeout: 40000 })
      .toBe(true)
  }
  test.info().annotations.push({ type: 'turns', description: `${rolls} rolls, ${moves} piece moves` })
  expect(rolls).toBeGreaterThanOrEqual(6)
  await expect(page.getByTestId('player-red')).toContainText('Robin')
  await expect(page.getByTestId('player-blue')).toContainText('Jules')
  await expect(page.getByTestId('player-blue')).toContainText('AI')
  await page.screenshot({ path: 'test-results/smoke-hearth.png', fullPage: true })
  expect(problems).toEqual([])
})

test('prism: card decisions advance the game until several turns or a completed round', async ({ page }) => {
  test.setTimeout(180000)
  const problems = watch(page)
  await page.goto('/#/prism')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
  await expect(page).toHaveURL(ROOM, { timeout: 30000 })
  await expect(page.locator('.pr-card')).toHaveCount(7, { timeout: 20000 })

  const legal = page.locator('.pr-card:enabled')
  const draw = page.getByRole('button', { name: /^(Draw card|Draw \d+)$/ })
  const keep = page.getByRole('button', { name: 'Keep & pass', exact: true })
  const call = page.getByRole('button', { name: 'Call Prism!', exact: true })
  const result = page.getByRole('dialog', { name: 'Round result', exact: true })
  const played: string[] = []
  const deadline = Date.now() + 110000
  while (played.length < 8 && Date.now() < deadline) {
    await expect
      .poll(
        async () =>
          (await result.isVisible()) ||
          (await keep.isVisible()) ||
          (await legal.count()) > 0 ||
          (await enabledNow(draw)),
        { timeout: 45000 },
      )
      .toBe(true)
    if (await result.isVisible()) break
    if (await keep.isVisible()) {
      await keep.click()
      await expect(keep).toBeHidden()
      played.push('kept & passed')
    } else if (await legal.count()) {
      if (await enabledNow(call)) {
        await call.click()
        played.push('called Prism!')
      }
      const card = legal.first()
      const name = (await card.getAttribute('aria-label')) ?? ''
      const held = await page.locator('.pr-card').count()
      await card.click()
      await page.getByRole('button', { name: 'Play card', exact: true }).click()
      const color = page.getByRole('dialog', { name: 'Choose a color' })
      if (await color.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: 'Choose blue', exact: true }).click()
        played.push('chose blue')
      }
      // Duplicate card faces can stay in the hand after one is played.
      await expect(page.locator('.pr-card')).toHaveCount(held - 1)
      played.push(name.replace(/, (not )?playable$/, ''))
    } else {
      // A draw is a card in the hand, whether it then gets played or kept.
      const label = await draw.innerText()
      const held = await page.locator('.pr-card').count()
      await draw.click()
      await expect(page.locator('.pr-card')).not.toHaveCount(held)
      played.push(label.trim())
    }
  }
  test.info().annotations.push({ type: 'turns', description: played.join(' → ') })
  // An unseeded bot can win before eight decisions; a completed round is
  // also evidence that play advanced, rather than a reason to wait for a turn.
  expect(played.length >= 4 || (await result.isVisible())).toBe(true)
  // The seat the room plays showed up in the table's own account of the round.
  await expect(page.locator('.pr-feed, .pr-table-log').first()).toContainText('Jules')
  await page.screenshot({ path: 'test-results/smoke-prism.png', fullPage: true })
  expect(problems).toEqual([])
})

test('wildrise: six rolls against the bot, each one reported and handed back', async ({ page }) => {
  test.setTimeout(180000)
  const problems = watch(page)
  await page.goto('/#/wildrise')
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(ROOM, { timeout: 30000 })
  await expect(page.locator('.wr-players .wr-player-info strong')).toHaveCount(2, { timeout: 30000 })

  const roll = page.getByRole('button', { name: 'Roll dice', exact: true })
  const events = page.locator('.wr-events')
  for (let turn = 0; turn < 6; turn++) {
    await expect(roll).toBeEnabled({ timeout: 45000 })
    const before = await events.innerText()
    await roll.click()
    await expect(events).not.toHaveText(before, { timeout: 30000 })
    await expect(events).toContainText('Robin rolled')
    if (await page.getByRole('button', { name: 'Play again' }).isVisible()) break
  }
  await expect(events).toContainText('Jules')
  await page.screenshot({ path: 'test-results/smoke-wildrise.png', fullPage: true })
  expect(problems).toEqual([])
})

test('chess: an opening against the easy bot, three moves each', async ({ page }) => {
  test.setTimeout(180000)
  const problems = watch(page)
  await page.addInitScript(() => {
    localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false, reducedMotion: true }))
  })
  await page.goto('/#/chess')
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page).toHaveURL(ROOM, { timeout: 30000 })
  await page.getByRole('button', { name: /Play as White/ }).click()
  await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
  await page.getByLabel('Bot skill for Play as Black', { exact: true }).selectOption('easy')
  await page.getByRole('button', { name: 'Add bot', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Remove / })).toBeVisible()
  await page.getByRole('button', { name: /^Start/ }).click()
  const whiteToMove = page.getByRole('heading', { name: 'White’s turn.', exact: true })
  await expect(whiteToMove).toBeVisible({ timeout: 30000 })

  // The board cursor starts on e2 and stays where the last move left it, so
  // each line walks from the previous destination: e2–e4, then d2–d4, then g1–f3.
  const board = page.getByRole('group', { name: '3D chessboard', exact: true })
  const history = page.getByLabel('Move history')
  const opening: [string, string[]][] = [
    ['e4', ['Enter', 'ArrowUp', 'ArrowUp', 'Enter']],
    ['d4', ['ArrowLeft', 'ArrowDown', 'ArrowDown', 'Enter', 'ArrowUp', 'ArrowUp', 'Enter']],
    [
      'Nf3',
      [
        'ArrowRight',
        'ArrowRight',
        'ArrowRight',
        'ArrowDown',
        'ArrowDown',
        'ArrowDown',
        'Enter',
        'ArrowUp',
        'ArrowUp',
        'ArrowLeft',
        'Enter',
      ],
    ],
  ]
  let plies = 0
  for (const [san, keys] of opening) {
    await board.focus()
    for (const key of keys) await page.keyboard.press(key)
    plies += 2
    // Both plies: ours, and the reply searched on the server.
    await expect(page.getByText(`${plies} moves`, { exact: true })).toBeVisible({ timeout: 40000 })
    await expect(whiteToMove).toBeVisible({ timeout: 30000 })
    await expect(history).toContainText(san)
  }
  test
    .info()
    .annotations.push({ type: 'game', description: (await history.innerText()).replace(/\s+/g, ' ') })
  await page.screenshot({ path: 'test-results/smoke-chess.png', fullPage: true })
  expect(problems).toEqual([])
})
