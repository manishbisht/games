import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * Nothing at an online Prism table is applied optimistically: every card this
 * browser plays goes to the room and comes back as a new deal. So each wait here
 * is on a piece of UI the room has already sent — and, wherever the pre-action
 * state would have satisfied the assertion on its own, on the affordance we just
 * used going away rather than on the next one turning up.
 */
const turnLine = (page: Page) => page.locator('.pr-turn-announcement strong')
const myTurn = (page: Page) => page.getByText('Your turn. Make it colorful.', { exact: true })
const cards = (page: Page) => page.locator('.pr-card')

async function newPlayer(browser: Browser, errors: string[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

/**
 * Play the one decision the table is waiting on: a card if any is legal, and
 * otherwise a draw — which may itself hand back a card worth playing.
 */
async function takeTurn(page: Page) {
  for (let step = 0; step < 4; step++) {
    const held = await cards(page).count()
    const legal = page.locator('.pr-card:enabled')
    if (await legal.count()) {
      await legal.first().click()
      const play = page.getByRole('button', { name: 'Play card', exact: true })
      if (await play.count()) await play.click()
      const colors = page.getByRole('dialog', { name: 'Choose a color', exact: true })
      if (await colors.count()) await colors.getByRole('button', { name: 'Choose red', exact: true }).click()
      // The card leaves this hand only once the room says it did.
      await expect(cards(page)).toHaveCount(held - 1)
      return
    }
    const keep = page.getByRole('button', { name: 'Keep & pass', exact: true })
    if (await keep.count()) {
      await keep.click()
      await expect(keep).toHaveCount(0)
      return
    }
    await page.getByRole('button', { name: 'Draw card', exact: true }).click()
    await expect(cards(page)).toHaveCount(held + 1)
    // A drawn card that can be played leaves the turn where it is.
    if (!(await myTurn(page).isVisible())) return
  }
  throw new Error('the turn would not settle')
}

/**
 * Play this browser's turns until the table is the other seat's. A reverse or a
 * skip at a two-seat table comes straight back around, so how many turns that
 * takes is the cards' business.
 */
async function handOver(page: Page) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!(await myTurn(page).isVisible())) return
    await takeTurn(page)
  }
  throw new Error('the turn never left this browser')
}

/** What the table can see of a hand it is not holding: a number, never a face. */
async function seenAcrossTheTable(watcher: Page, held: number) {
  await expect(watcher.locator('.pr-opponent .pr-card')).toHaveCount(0)
  await expect(watcher.locator('.pr-opponent')).toContainText(held === 1 ? '1 CARD LEFT' : `${held} cards`)
}

test('two browsers deal, play and keep their cards to themselves', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/prism')
  await host.getByLabel('Your name').fill('Ann')
  // Two seats: the smallest table Prism offers, and the one this test can drive.
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '2' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/prism\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await guest.goto(`/#/prism/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()
  await expect(guest.getByRole('heading', { name: `Room ${code}` })).toBeVisible()

  await host.getByRole('button', { name: /Take seat 1/ }).click()
  await expect(host.getByRole('button', { name: /Leave seat/ })).toContainText('Ann')
  await guest.getByRole('button', { name: /Take seat 2/ }).click()
  // The host only learns the second seat is filled through the broadcast snapshot.
  await expect(host.getByRole('button', { name: /Take seat 2/ })).toContainText('Ben')
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()

  // Seven cards each, dealt on the server — and each browser holds exactly its
  // own seven. Fourteen in this DOM would mean the other hand came with them.
  await expect(cards(host)).toHaveCount(7)
  await expect(cards(guest)).toHaveCount(7)
  await expect(host.locator('.pr-opponent')).toContainText('Ben')
  await expect(guest.locator('.pr-opponent')).toContainText('Ann')
  await seenAcrossTheTable(host, 7)
  await seenAcrossTheTable(guest, 7)
  await expect(host.locator('.pr-table-render canvas')).toBeVisible()
  await host.screenshot({ path: 'test-results/prism-online-host.png', fullPage: true })

  // The turn belongs to one seat at a time; the other seat can only watch.
  await expect(myTurn(host)).toBeVisible()
  await expect(host.getByRole('button', { name: 'Draw card', exact: true })).toBeEnabled()
  await expect(turnLine(guest)).toHaveText('Ann’s turn')
  await expect(guest.getByRole('button', { name: 'Draw card', exact: true })).toBeDisabled()
  await expect(guest.locator('.pr-card:enabled')).toHaveCount(0)

  await handOver(host)
  // The offer to play is what has to go: the turn only passed when it did.
  await expect(myTurn(host)).toHaveCount(0)
  await expect(turnLine(host)).toHaveText('Ben’s turn')
  // Both browsers were told by the same snapshot, so both agree whose turn it is.
  await expect(myTurn(guest)).toBeVisible()
  // And whatever has been played since, each DOM still holds one hand.
  await seenAcrossTheTable(guest, await cards(host).count())

  await handOver(guest)
  await expect(myTurn(guest)).toHaveCount(0)
  await expect(myTurn(host)).toBeVisible()
  await seenAcrossTheTable(host, await cards(guest).count())

  // A reload reconnects with the stored guest id, reclaiming the seat mid-round
  // — and the hand comes back because the room, not the browser, was holding it.
  const held = await cards(guest).count()
  await guest.reload()
  await expect(cards(guest)).toHaveCount(held)
  await expect(turnLine(guest)).toHaveText('Ann’s turn')
  await expect(guest.getByRole('button', { name: 'Draw card', exact: true })).toBeDisabled()
  await handOver(host)
  await expect(myTurn(guest)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Draw card', exact: true })).toBeEnabled()

  await guest.screenshot({ path: 'test-results/prism-online-guest.png', fullPage: true })
  expect(errors).toEqual([])
})

test('a table made for four deals to the two who turned up', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/prism')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('group', { name: 'Table size' }).getByRole('button', { name: '4' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/prism\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]
  await expect(host.getByRole('button', { name: /Take seat 4/ })).toBeVisible()
  await host.screenshot({ path: 'test-results/prism-online-lobby.png', fullPage: true })

  await guest.goto(`/#/prism/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()

  // Two of the four seats stay empty, and Prism does not insist on a full table.
  await host.getByRole('button', { name: /Take seat 1/ }).click()
  await guest.getByRole('button', { name: /Take seat 4/ }).click()
  await expect(host.getByRole('button', { name: 'Start with 2 players' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start with 2 players' }).click()

  // The two who came slide onto the first two seats, in the order they sat.
  await expect(cards(host)).toHaveCount(7)
  await expect(host.locator('.pr-opponent')).toHaveCount(1)
  await expect(host.locator('.pr-opponent')).toContainText('Ben')
  await expect(myTurn(host)).toBeVisible()
  await expect(turnLine(guest)).toHaveText('Ann’s turn')
  expect(errors).toEqual([])
})
