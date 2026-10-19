import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * Wildrise at full motion, held still. The page runs under the test clock, so a
 * spec can freeze every stage, step it by exact milliseconds and photograph the
 * frame — the die in the air, a token between two squares, a joiner's board
 * mid-walk. Nothing here compares pixels (GPU output differs between machines);
 * the screenshots are for looking at, and what is asserted is ordering: the HUD
 * only counts a square once the token has landed on it.
 *
 * The room still runs on its own clock, so a frozen board falls behind it. Each
 * freeze here is short, and long before the board's queue gives up on a backlog.
 */

interface Clock {
  __motionClock: { freeze(): void; release(): void; step(ms: number): Promise<void> }
}
const freeze = (page: Page) => page.evaluate(() => (window as unknown as Clock).__motionClock.freeze())
const release = (page: Page) => page.evaluate(() => (window as unknown as Clock).__motionClock.release())
const step = (page: Page, ms: number) =>
  page.evaluate((ms) => (window as unknown as Clock).__motionClock.step(ms), ms)

/**
 * Steps a frozen board a frame at a time until `kind` is the beat it is
 * playing, so a short beat (a one-square walk is 190ms) is caught at its start.
 */
const stepUntilBeat = (page: Page, kind: string, maxMs = 6000) =>
  page.evaluate(
    async ({ kind, maxMs }) => {
      const clock = (window as unknown as Clock).__motionClock,
        el = document.querySelector<HTMLElement>('.wr-canvas')!
      for (let t = 0; el.dataset.beat !== kind && t < maxMs; t += 1000 / 60) await clock.step(1000 / 60)
      return el.dataset.beat
    },
    { kind, maxMs },
  )

const rollButton = (page: Page) => page.getByRole('button', { name: 'Roll dice', exact: true })
const board = (page: Page) => page.locator('.wr-canvas')
/** The square a seat's card shows, `—` (at camp) read as 0. */
async function cardSquare(page: Page, colour: string) {
  const text = await page.getByTestId(`wildrise-player-${colour}`).locator('.wr-position strong').innerText()
  return text === '—' ? 0 : Number(text)
}

async function openPage(browser: Browser, errors: string[]) {
  const context = await browser.newContext({ reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('games-test-clock', 'on')
    localStorage.setItem('games-motion', 'full')
  })
  return page
}

async function startBotGame(page: Page) {
  await page.goto('/#/wildrise')
  await page.getByLabel('Your name', { exact: true }).fill('Robin')
  await page.getByRole('button', { name: 'Start game', exact: true }).click()
  await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/, { timeout: 30000 })
  // The host takes the first seat, and the first colour.
  await expect(page.getByTestId('wildrise-player-red')).toContainText('Robin', { timeout: 30000 })
}

/** Where the scene says its die rests on screen, once the camera has held still long enough to trust it. */
async function restingDie(page: Page) {
  const read = () =>
    board(page).evaluate((el) =>
      el.dataset.dieX === undefined ? null : `${el.dataset.dieX},${el.dataset.dieY}`,
    )
  let seen: string | null = null
  await expect
    .poll(
      async () => {
        const before = seen
        seen = await read()
        return seen !== null && seen === before
      },
      { intervals: [800], timeout: 30000 },
    )
    .toBe(true)
  const box = (await page.locator('.wr-canvas canvas').boundingBox())!
  const [x, y] = seen!.split(',').map(Number)
  return { x: box.x + x, y: box.y + y }
}

test('the die is thrown, the token walks it hop by hop, and the card only counts what has landed', async ({
  browser,
}) => {
  test.setTimeout(120000)
  const errors: string[] = []
  const page = await openPage(browser, errors)
  await startBotGame(page)
  await expect(rollButton(page)).toBeEnabled({ timeout: 40000 })
  const before = await cardSquare(page, 'red')

  // 1. The toss: tap the die itself, and hold the frame while it is in the air.
  const die = await restingDie(page)
  await page.mouse.click(die.x, die.y)
  await expect(board(page)).toHaveAttribute('data-beat', 'roll', { timeout: 15000 })
  await freeze(page)
  await step(page, 380)
  await page.screenshot({ path: 'test-results/wildrise-motion-1-toss.png' })
  // The die is still in the air: the token has not moved, and neither has its card.
  expect(await cardSquare(page, 'red')).toBe(before)

  // 2. The walk, held between two squares.
  expect(await stepUntilBeat(page, 'walk')).toBe('walk')
  const rolled = Number(
    (await page.locator('.wr-events li').first().innerText()).match(/Robin rolled (\d)/)?.[1],
  )
  expect(rolled).toBeGreaterThanOrEqual(1)
  const target = before + rolled,
    walkMs = 190 * rolled
  await step(page, walkMs * 0.55)
  await page.screenshot({ path: 'test-results/wildrise-motion-2-walk.png' })
  // Halfway through, the card has counted the squares landed on so far — and
  // not the square the room already knows the walk ends on.
  const midway = await cardSquare(page, 'red')
  expect(midway).toBeGreaterThanOrEqual(before)
  expect(midway).toBeLessThan(target)

  // 3. The landing: only now does the card reach the square.
  await step(page, walkMs * 0.5 + 50)
  await expect(page.getByTestId('wildrise-player-red').locator('.wr-position strong')).toHaveText(
    String(target),
  )
  await page.screenshot({ path: 'test-results/wildrise-motion-3-landed.png' })

  // A ladder or a snake at the end of it: the ride is its own beat, and the
  // card keeps the square it started from until the token is off at the other end.
  await step(page, 120)
  if ((await board(page).getAttribute('data-beat')) === 'ride') {
    await step(page, 1650 * 0.5)
    await page.screenshot({ path: 'test-results/wildrise-motion-4-ride.png' })
    expect(await cardSquare(page, 'red')).toBe(target)
    await step(page, 1650 * 0.6)
    await expect.poll(() => cardSquare(page, 'red')).not.toBe(target)
  }
  await release(page)
  // The table carries on: the turn comes back round to this seat.
  await expect(rollButton(page)).toBeEnabled({ timeout: 40000 })
  expect(errors).toEqual([])
})

test('a browser that joins mid-walk picks it up where the table is, rather than replaying it', async ({
  browser,
}) => {
  test.setTimeout(180000)
  const errors: string[] = []
  const host = await openPage(browser, errors)
  await startBotGame(host)
  // The host rolls whenever the die is theirs; the room plays the bot's turns.
  await host.evaluate(() =>
    setInterval(() => {
      const roll = document.querySelector<HTMLButtonElement>('.wr-roll')
      if (roll && !roll.disabled) roll.click()
    }, 150),
  )
  let compared = false
  for (let attempt = 0; attempt < 10 && !compared; attempt++) {
    const guest = await openPage(browser, errors)
    await guest.goto(host.url())
    await guest.getByLabel('Your name').fill(`Wren ${attempt}`)
    // The moment a token sets off on the host's board, someone else opens the table.
    await expect(board(host)).not.toHaveAttribute('data-beat', 'walk', { timeout: 30000 })
    await expect(board(host)).toHaveAttribute('data-beat', 'walk', { timeout: 30000 })
    const walker = (await host.locator('.wr-player-active').getAttribute('data-testid'))!.replace(
      'wildrise-player-',
      '',
    )
    const before = await cardSquare(host, walker)
    await guest.getByRole('button', { name: 'Join room' }).click()
    // Hold both boards on the first frame the joiner can show.
    await guest.waitForFunction(
      () => {
        const clock = (window as unknown as Partial<Clock>).__motionClock
        if (!clock || !document.querySelector('.wr-canvas')?.getAttribute('data-beat')) return false
        clock.freeze()
        return true
      },
      null,
      { polling: 'raf', timeout: 30000 },
    )
    await freeze(host)
    if ((await board(guest).getAttribute('data-beat')) === 'walk') {
      // The cards count up to what each board has landed (in under 0.6s), and
      // the joiner's page finishes crossing over to the table.
      await guest.waitForTimeout(800)
      await guest.screenshot({ path: 'test-results/wildrise-motion-join-guest.png' })
      const hostAt = await cardSquare(host, walker),
        guestAt = await cardSquare(guest, walker)
      // A fair comparison needs the host to be well into the walk.
      if (hostAt - before >= 3) {
        compared = true
        await host.screenshot({ path: 'test-results/wildrise-motion-join-host.png' })
        // The joiner is where the table is, give or take the hop it took to
        // build its board — not back at the start, re-walking it.
        expect(guestAt).toBeGreaterThan(before)
        expect(Math.abs(hostAt - guestAt)).toBeLessThanOrEqual(2)
      }
    }
    await release(host)
    await guest.context().close()
  }
  test.skip(!compared, 'No walk was long enough to join in the middle of.')
  expect(errors).toEqual([])
})
