import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * The table is paced by the server — the die spins, pieces walk and skipped
 * turns are held on its clock, not this browser's. So every wait here is on a
 * piece of UI the room has already sent, never on a duration.
 *
 * The roll button carries the whole turn state in its label: `Roll dice` when
 * the dice are ours, `Waiting…` when they are the other seat's, `Choose a piece`
 * once a roll has landed — and one of the in-between labels (`Rolling…`,
 * `On the way…`, `Next player…`) while a beat is still running.
 */
const AT_REST = /^(Roll dice|Waiting…|Choose a piece)$/
const rollButton = (page: Page) => page.getByRole('button', { name: 'Roll dice', exact: true })
const turnHeading = (page: Page, name: string) =>
  page.getByRole('heading', { name: `${name}’s turn`, exact: true })
/** Wait out whatever beat the server is holding, however long it holds it. */
const settle = (page: Page) => expect(page.getByRole('button', { name: AT_REST })).toBeVisible()

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

/** Roll, then play a piece if the roll offered one. */
async function takeTurn(page: Page) {
  await expect(rollButton(page)).toBeEnabled()
  await rollButton(page).click()
  // Nothing here is applied optimistically, so the offer to roll stands until
  // the room has echoed it back — waiting for it to go is what "sent" means.
  await expect(rollButton(page)).toHaveCount(0)
  await settle(page)
  // Which pieces a roll frees is the die's business, so take the first one the
  // room says is playable — there may be none at all, which skips the turn.
  const choices = page.locator('.hh-piece-choices')
  const playable = choices.locator('button:not([disabled])').first()
  if (await playable.count()) {
    await playable.click()
    await expect(choices).toHaveCount(0)
    await settle(page)
  }
}

/**
 * Play this page's turns until the table is the other seat's. A six earns
 * another roll, so how many turns that takes is the server's to decide.
 */
async function handOver(page: Page, theirs: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await settle(page)
    if (await turnHeading(page, theirs).isVisible()) return
    await takeTurn(page)
  }
  throw new Error(`the turn never reached ${theirs}`)
}

test('two browsers create, join, and play a server-paced hearth table', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/hearth-and-home')
  await host.getByLabel('Your name').fill('Ann')
  // Two seats: the smallest table Hearth offers, and the one this test can drive.
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '2' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/hearth-and-home\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await guest.goto(`/#/hearth-and-home/room/${code}`)
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
  await expect(host.locator('.hh-canvas canvas')).toBeVisible()
  await expect(guest.locator('.hh-canvas canvas')).toBeVisible()
  await expect(host.getByTestId('player-red')).toContainText('Ann')
  await expect(host.getByTestId('player-blue')).toContainText('Ben')
  await expect(guest.getByTestId('player-blue')).toContainText('YOU')
  // The dice belong to one seat at a time; the other seat can only watch.
  await expect(turnHeading(host, 'Ann')).toBeVisible()
  await expect(rollButton(host)).toBeEnabled()
  await expect(guest.getByRole('button', { name: 'Waiting…', exact: true })).toBeDisabled()

  await handOver(host, 'Ben')
  // Both browsers were told by the same snapshot, so both agree whose turn it is.
  await expect(turnHeading(guest, 'Ben')).toBeVisible()
  await expect(rollButton(guest)).toBeEnabled()
  await expect(host.getByRole('button', { name: 'Waiting…', exact: true })).toBeDisabled()
  await handOver(guest, 'Ann')
  await expect(turnHeading(host, 'Ann')).toBeVisible()

  // A reload reconnects with the stored guest id, reclaiming the seat mid-game.
  await guest.reload()
  await expect(guest.getByTestId('player-blue')).toContainText('YOU')
  await expect(turnHeading(guest, 'Ann')).toBeVisible()
  await handOver(host, 'Ben')
  await expect(turnHeading(guest, 'Ben')).toBeVisible()
  await expect(rollButton(guest)).toBeEnabled()

  await host.screenshot({ path: 'test-results/hearth-online-host.png', fullPage: true })
  await guest.screenshot({ path: 'test-results/hearth-online-guest.png', fullPage: true })
  expect(errors).toEqual([])
})

test('a table made for three plays with the two who turned up', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/hearth-and-home')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '3' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/hearth-and-home\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('button', { name: /Take seat 3/ })).toBeVisible()
  await host.screenshot({ path: 'test-results/hearth-online-lobby.png', fullPage: true })

  await guest.goto(`/#/hearth-and-home/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()

  // Seat 3 stays empty, and Hearth does not insist on a full table.
  await host.getByRole('button', { name: /Take seat 1/ }).click()
  await guest.getByRole('button', { name: /Take seat 3/ }).click()
  await expect(host.getByRole('button', { name: 'Start with 2 players' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start with 2 players' }).click()

  // The two who came slide onto the first two seats, in the order they sat.
  await expect(host.getByTestId('player-red')).toContainText('Ann')
  await expect(host.getByTestId('player-blue')).toContainText('Ben')
  await expect(host.getByTestId('player-green')).toHaveCount(0)
  await expect(guest.getByTestId('player-blue')).toContainText('YOU')
  await expect(turnHeading(host, 'Ann')).toBeVisible()
  expect(errors).toEqual([])
})
