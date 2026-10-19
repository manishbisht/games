import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Prism in full motion, held still by the test clock: every stage on the page
 * freezes, and the spec advances it by exact milliseconds to look at the deal,
 * a card in the air and the room's reply mid-flight. What is asserted is
 * ordering, read off the DOM around the table — a card counts on the pile only
 * once it lands there, a dealt card joins the hand only as it arrives, the turn
 * comes back only when the table has shown everything before it — and that a
 * page arriving part-way through a beat picks it up from the room's clock.
 * Screenshots are for looking at, never compared: GPU output differs by machine.
 */
declare global {
  interface Window {
    __motionClock?: { freeze(): void; release(): void; step(ms: number): Promise<void> }
  }
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('games-test-clock', 'on')
    localStorage.setItem('games-motion', 'full')
    localStorage.setItem('games-guide-prism', 'done')
  })
})

const freeze = async (page: Page) => {
  await page.waitForFunction(() => Boolean(window.__motionClock))
  await page.evaluate(() => window.__motionClock!.freeze())
}
const step = (page: Page, ms: number) => page.evaluate((ms) => window.__motionClock!.step(ms), ms)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/prism-motion-${name}.png` })

const busy = (page: Page) => page.locator('.pr-arena[aria-busy="true"]')
const pending = (page: Page) => page.locator('.pr-card.pr-pending')
const cards = (page: Page) => page.locator('.pr-card')
const inPlay = (page: Page) => page.locator('.pr-pile-name', { hasText: 'IN PLAY' }).locator('small')
const headline = (page: Page) => page.locator('.pr-turn-announcement strong')
const myTurn = (page: Page) => page.getByText('Your turn. Make it colorful.', { exact: true })
const draw = (page: Page) => page.getByRole('button', { name: /^(Draw card|Draw \d+)$/ })

/**
 * How far the room has got. With the clock held it can be ahead of what the
 * table shows: the room answers in real time, and the table only tells it as
 * it is stepped.
 */
const sequence = async (page: Page) => Number(await page.locator('.pr-arena').getAttribute('data-sequence'))
/** Waits, clock still, for the room to say something after `seen`. */
const answer = (page: Page, seen: number) =>
  expect.poll(() => sequence(page), { timeout: 20000 }).toBeGreaterThan(seen)

/**
 * Steps the frozen table until it has shown everything the room has said so
 * far. Idle is read and acted on in one place: the room keeps talking in real
 * time, and a story that arrives once the table has come to rest is left for
 * whatever comes next rather than raced by a second look.
 */
async function settle(page: Page) {
  for (let i = 0; i < 40; i++) {
    if (!(await busy(page).count())) return
    await step(page, 400)
  }
  throw new Error('The table was still telling its story after 16s of its own time.')
}

/** A solo table against one bot, dealt by the server with this page's clock already frozen. */
async function startTable(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/prism')
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
  await page.getByRole('button', { name: '2 players', exact: true }).click()
  // The menu's own table has already brought the clock in; the room's table shares it.
  await freeze(page)
  await page.getByRole('button', { name: 'Let’s play', exact: true }).click()
  await expect(page).toHaveURL(/\/prism\/room\/[A-Z2-9]{6}$/, { timeout: 20000 })
  await expect(page.locator('.pr-is-playing')).toBeVisible({ timeout: 30000 })
  await expect(cards(page)).toHaveCount(7)
}

test('the deal, a card of yours and the bot’s reply each land before the table moves on', async ({
  page,
}) => {
  test.setTimeout(120000)
  const errors: string[] = []
  await startTable(page, errors)

  // The deal. Nothing has landed: every card of the hand is still in the air,
  // the pile is empty and the table says it is shuffling.
  await expect(busy(page)).toHaveCount(1)
  await expect(headline(page)).toHaveText('Shuffling up.')
  await expect(pending(page)).toHaveCount(7)
  await expect(inPlay(page)).toHaveText('—')
  await expect(draw(page)).toBeDisabled()
  await step(page, 350)
  await shot(page, '1-riffle')
  await expect(pending(page)).toHaveCount(7)
  // Part-way round the table: some of the hand has arrived, the rest has not.
  await step(page, 1150)
  await shot(page, '2-deal')
  const partway = await pending(page).count()
  expect(partway).toBeGreaterThan(0)
  expect(partway).toBeLessThan(7)
  await expect(inPlay(page)).toHaveText('—')
  await expect(page.locator('.pr-opponent')).not.toHaveAttribute('aria-label', /, 7 cards/)
  await settle(page)
  await shot(page, '3-dealt')
  await expect(pending(page)).toHaveCount(0)
  await expect(page.locator('.pr-opponent')).toHaveAttribute('aria-label', /, 7 cards/)
  await expect(inPlay(page)).not.toHaveText('—')

  // Your move. A card you play leaves the hand at once, but the pile only
  // names it when it lands; a card you draw keeps its place empty until then.
  await expect(myTurn(page)).toBeVisible()
  const before = await inPlay(page).textContent()
  const legal = page.locator('.pr-card.pr-playable')
  // How far the room had got once it took this seat's move: the bot's answer is whatever comes after.
  let mine: number
  if (await legal.count()) {
    const name = (await legal.first().getAttribute('aria-label'))!.split(',')[0]
    await legal.first().click()
    await page.getByRole('button', { name: 'Play card', exact: true }).click()
    const colors = page.getByRole('dialog', { name: 'Choose a color', exact: true })
    if (await colors.count()) await colors.getByRole('button', { name: 'Choose red', exact: true }).click()
    await expect(cards(page)).toHaveCount(6)
    mine = await sequence(page)
    await expect(busy(page)).toHaveCount(1)
    await step(page, 160)
    await shot(page, '4-your-card-in-flight')
    await expect(inPlay(page)).toHaveText(before!)
    // A flight is at most ~0.7s; the bot's answer is more than a second behind it.
    await step(page, 700)
    await expect(inPlay(page)).toHaveText(name)
    await settle(page)
  } else {
    await draw(page).click()
    await expect(cards(page)).toHaveCount(8)
    mine = await sequence(page)
    await expect(pending(page)).toHaveCount(1)
    await expect(page.locator('.pr-hand-topline b')).toHaveText('7')
    await step(page, 200)
    await shot(page, '4-your-draw-in-flight')
    await expect(pending(page)).toHaveCount(1)
    await settle(page)
    await expect(pending(page)).toHaveCount(0)
    await expect(page.locator('.pr-hand-topline b')).toHaveText('8')
    const keep = page.getByRole('button', { name: 'Keep & pass', exact: true })
    if (await keep.count()) {
      await keep.click()
      await answer(page, mine)
      mine = await sequence(page)
      await expect(keep).toHaveCount(0)
    }
  }

  // The bot's reply, which the room sends while this page's clock stands still.
  // A move of yours may hand the turn straight back (a skip or reverse between
  // two), or the bot's answer may already have been shown; keep drawing until
  // the bot is on. Nothing is stepped once the turn is the bot's, so its answer
  // arrives to a table still holding it back.
  for (let i = 0; i < 6 && (await myTurn(page).isVisible()); i++) {
    await draw(page).click()
    await answer(page, mine)
    mine = await sequence(page)
    // A card that fits keeps the turn here: see it land, then keep it.
    if (await page.locator('.pr-card.pr-just-drawn').count()) {
      await settle(page)
      await page.getByRole('button', { name: 'Keep & pass', exact: true }).click()
      await answer(page, mine)
      mine = await sequence(page)
    }
  }
  await answer(page, mine)
  await expect(busy(page)).toHaveCount(1, { timeout: 20000 })
  // However long the story, the turn is not offered back until it has been shown.
  await expect(myTurn(page)).toHaveCount(0)
  await expect(draw(page)).toBeDisabled()
  await step(page, 250)
  await shot(page, '5-bot-reply')
  await settle(page)
  await shot(page, '6-settled')
  await expect(page.locator('.pr-feed')).toContainText('Jules')
  expect(errors).toEqual([])
})

test('a page that reloads mid-deal picks it up part-way, and one that reloads later finds it landed', async ({
  page,
}) => {
  test.setTimeout(120000)
  const errors: string[] = []
  await startTable(page, errors)

  // The room dealt a moment ago by its own clock. Coming back to the table
  // while this page's clock is held still, the deal is not started over: what
  // the room has already dealt is already in the hand.
  await page.waitForTimeout(1600)
  await page.reload()
  await freeze(page)
  await expect(page.locator('.pr-is-playing')).toBeVisible({ timeout: 30000 })
  await expect(cards(page)).toHaveCount(7)
  expect(await pending(page).count()).toBeLessThan(7)
  // One frame, so there is a picture to look at.
  await step(page, 16)
  await shot(page, '7-reloaded-mid-deal')
  await settle(page)
  await expect(pending(page)).toHaveCount(0)
  await expect(inPlay(page)).not.toHaveText('—')

  // A move made well before the page comes back is simply there, at rest:
  // play on in real time until the room is waiting on this seat again, after
  // the bot's last word, and come back a while later.
  await expect(myTurn(page)).toBeVisible()
  await draw(page).click()
  await expect(cards(page)).toHaveCount(8)
  await settle(page)
  const keep = page.getByRole('button', { name: 'Keep & pass', exact: true })
  if (await keep.count()) await keep.click()
  await expect(myTurn(page)).toHaveCount(0)
  await page.evaluate(() => window.__motionClock!.release())
  await expect(myTurn(page)).toBeVisible({ timeout: 30000 })
  await expect(busy(page)).toHaveCount(0)
  const held = await cards(page).count(),
    top = await inPlay(page).textContent()
  await page.waitForTimeout(1500)
  await page.reload()
  await freeze(page)
  await expect(page.locator('.pr-is-playing')).toBeVisible({ timeout: 30000 })
  await expect(cards(page)).toHaveCount(held)
  // Told again from the start, the bot's move would still be in the air here.
  await page.waitForTimeout(300)
  await expect(busy(page)).toHaveCount(0)
  await expect(pending(page)).toHaveCount(0)
  await expect(inPlay(page)).toHaveText(top!)
  await expect(myTurn(page)).toBeVisible()
  await step(page, 16)
  await shot(page, '8-reloaded-after')
  expect(errors).toEqual([])
})
