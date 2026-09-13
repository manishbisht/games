import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * The table is paced by the server — the dice spin and the token walks on its
 * clock, not this browser's — so every wait here is on a piece of UI the room
 * has already sent, never on a duration.
 *
 * The dock's one button carries the whole turn state in its label: `Roll dice`
 * when the dice are ours, `Ben is playing…` when they are the other seat's,
 * `Buy for $X` or `End turn` once a roll has landed, and `Rolling the dice…` /
 * `On the move…` while the room is still holding a beat.
 */
const BUSY = /^(Rolling the dice…|On the move…)$/
const rollButton = (page: Page) => page.getByRole('button', { name: /^Roll dice/ })
const turnOf = (page: Page) => page.locator('.turn-eyebrow')
/** Wait out whatever beat the server is holding, however long it holds it. */
const settle = (page: Page) =>
  expect(page.getByRole('button', { name: BUSY })).toHaveCount(0, { timeout: 20000 })

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

/**
 * Take whichever single decision the table is offering this page — read a card,
 * leave what is for sale on the market, roll, raise cash, or pass the dice on.
 * Which of those a turn asks for is the dice's business, so the offer on screen
 * decides, and every click waits for its own affordance to go before returning:
 * nothing here is applied optimistically, so a button that is still there is a
 * decision the room has not echoed back yet.
 */
async function step(page: Page) {
  await settle(page)
  const offers = [
    page.getByRole('button', { name: 'Let’s see what’s next' }),
    page.getByRole('button', { name: 'Pass', exact: true }),
    page.getByRole('button', { name: /Raise cash/ }),
    rollButton(page),
    page.getByRole('button', { name: /^(End turn|Roll again)$/ }),
  ]
  for (const offer of offers) {
    if (!(await offer.count())) continue
    await expect(offer).toBeEnabled()
    await offer.click()
    await expect(offer).toHaveCount(0)
    return
  }
  throw new Error('the table is offering this page nothing to do')
}

/**
 * Play this page's decisions until the table is the other seat's. Doubles earn
 * another roll, so how many that takes is the server's to decide.
 */
async function handOver(page: Page, theirs: string) {
  for (let attempt = 0; attempt < 14; attempt++) {
    await settle(page)
    if (((await turnOf(page).textContent()) ?? '').includes(`${theirs}’S TURN`)) return
    await step(page)
  }
  throw new Error(`the turn never reached ${theirs}`)
}

test('two browsers create, join, and play a server-paced estate table', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  // The lobby lives where a game is set up, which for Estate is the setup dialog.
  await host.goto('/#/estate')
  await host.getByRole('button', { name: 'Start game' }).click()
  await host.getByLabel('Your name').fill('Ann')
  // Two seats: the smallest table Estate offers, and the one this test can drive.
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '2' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/estate\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await guest.goto(`/#/estate/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()
  await expect(guest.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  // Seats are numbered, not coloured: the tokens are handed out at the start.
  await host.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(host.getByRole('button', { name: /Leave seat/ })).toContainText('Ann')
  await guest.getByRole('button', { name: /Take seat 2/ }).click()
  // The host only learns the second seat is filled through the broadcast snapshot.
  await expect(host.getByRole('button', { name: /Take seat 2/ })).toContainText('Ben')
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()

  // The city is up on both sides, under the players' own names.
  await expect(host.locator('.board-canvas canvas')).toBeVisible({ timeout: 30000 })
  await expect(guest.locator('.board-canvas canvas')).toBeVisible({ timeout: 30000 })
  await expect(host.locator('.player-card').first()).toContainText('Ann')
  await expect(host.locator('.player-card').nth(1)).toContainText('Ben')
  await expect(guest.locator('.player-card').nth(1)).toContainText('YOU')
  await expect(host.getByText('ONLINE TABLE')).toBeVisible()

  // The dice belong to one seat at a time; the other seat can only watch.
  await expect(turnOf(host)).toHaveText(/ANN’S TURN/)
  await expect(rollButton(host)).toBeEnabled()
  await expect(guest.getByRole('button', { name: /^Ann is playing/ })).toBeDisabled()

  // One roll, watched from both sides: the room holds the dice, then hands back
  // a token that has already walked.
  await rollButton(host).click()
  await expect(rollButton(host)).toHaveCount(0)
  await expect(guest.getByRole('button', { name: /^Rolling the dice/ })).toBeVisible()
  await settle(host)
  await settle(guest)
  await expect(host.locator('.dice-result')).toBeVisible()
  await expect(guest.locator('.dice-result')).toHaveText(await host.locator('.dice-result').innerText())
  // The whole walk arrived in one snapshot: the dice were read out and the token
  // reached the space it stopped on, without this browser stepping it there.
  await expect(guest.locator('.activity-feed')).toContainText('rolled')
  await expect(guest.locator('.activity-feed')).toContainText('landed on')
  await host.screenshot({ path: 'test-results/estate-online-host.png', fullPage: true })

  // Finish the turn out and hand the dice over. Both browsers were told by the
  // same snapshot, so both agree whose turn it is now.
  await handOver(host, 'BEN')
  await expect(turnOf(guest)).toHaveText(/BEN’S TURN/)
  await expect(rollButton(guest)).toBeEnabled()
  await expect(host.getByRole('button', { name: /^Ben is playing/ })).toBeDisabled()
  await guest.screenshot({ path: 'test-results/estate-online-guest.png', fullPage: true })

  expect(errors).toEqual([])
})
