import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * The table is paced by the server — the die spins, the token walks and the turn
 * passes on its clock, not this browser's. So every wait here is on a piece of
 * UI the room has already sent, never on a duration.
 *
 * The roll button keeps a fixed `aria-label` in every phase, so its accessible
 * name cannot tell your turn from theirs. Its *text* carries the whole turn
 * state instead: `Roll dice` when the die is yours, `Waiting…` when it is the
 * other seat's, and one of the in-between labels (`Rolling…`, `On the move…`,
 * `Climbing…`, `Sliding…`, `Passing the die…`) while a beat is still running.
 */
const AT_REST = /^(Roll dice|Waiting…)/
const rollButton = (page: Page) => page.locator('.wr-roll')
const turnHeading = (page: Page, name: string) =>
  page.getByRole('heading', { name: `${name}’s turn.`, exact: true })
/** Wait out whatever beat the server is holding, however long it holds it. */
const settle = (page: Page) => expect(rollButton(page)).toHaveText(AT_REST)

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

/** Roll once, and wait for the room to carry the whole turn through. */
async function takeTurn(page: Page) {
  await expect(rollButton(page)).toHaveText(/^Roll dice/)
  await rollButton(page).click()
  // Nothing here is applied optimistically, so the offer to roll stands until
  // the room has echoed it back — waiting for it to go is what "sent" means.
  await expect(rollButton(page)).not.toHaveText(/^Roll dice/)
  await settle(page)
}

/** Play this page's turns until the table is the other seat's. */
async function handOver(page: Page, theirs: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await settle(page)
    if (await turnHeading(page, theirs).isVisible()) return
    await takeTurn(page)
  }
  throw new Error(`the turn never reached ${theirs}`)
}

test('two browsers create, join, and play a server-paced wildrise table', async ({ browser }) => {
  test.setTimeout(120000)
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/wildrise')
  await host.getByRole('button', { name: 'Play online', exact: true }).click()
  await host.getByLabel('Your name').fill('Ann')
  // Two seats: the smallest table Wildrise offers, and the one this test can drive.
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '2' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/wildrise\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await guest.goto(`/#/wildrise/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()
  await expect(guest.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  // Seats are numbered, not coloured: the colours are dealt out at the start.
  await host.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(host.getByRole('button', { name: /Leave seat/ })).toContainText('Ann')
  await guest.getByRole('button', { name: /Take seat 2/ }).click()
  // The host only learns the second seat is filled through the broadcast snapshot.
  await expect(host.getByRole('button', { name: /Take seat 2/ })).toContainText('Ben')
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()

  // The table is up on both sides, under the players' own names.
  await expect(host.locator('.wr-canvas canvas')).toBeVisible()
  await expect(guest.locator('.wr-canvas canvas')).toBeVisible()
  for (const page of [host, guest]) {
    await expect(page.getByTestId('wildrise-player-red')).toContainText('Ann')
    await expect(page.getByTestId('wildrise-player-blue')).toContainText('Ben')
  }
  // Each browser owns exactly one seat, and says so.
  await expect(host.getByTestId('wildrise-player-red').locator('.wr-seat-badge')).toHaveText('YOU')
  await expect(guest.getByTestId('wildrise-player-blue').locator('.wr-seat-badge')).toHaveText('YOU')

  // Whoever the room dealt the first turn to plays it; the other only watches.
  const first = (await turnHeading(host, 'Ann').isVisible()) ? host : guest
  const second = first === host ? guest : host
  await expect(rollButton(second)).toHaveText(/^Waiting…/)

  await takeTurn(first)
  await handOver(first, first === host ? 'Ben' : 'Ann')
  await takeTurn(second)

  // Both browsers are looking at the same table: same turn, same positions.
  const turn = await host.locator('.wr-table-badge').innerText()
  await expect(guest.locator('.wr-table-badge')).toHaveText(turn)
  for (const colour of ['red', 'blue']) {
    const at = await host.getByTestId(`wildrise-player-${colour}`).locator('.wr-position strong').innerText()
    await expect(guest.getByTestId(`wildrise-player-${colour}`).locator('.wr-position strong')).toHaveText(at)
  }

  expect(errors).toEqual([])
})
