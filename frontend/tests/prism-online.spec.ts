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
/**
 * The table arrives as its own chunk — three.js and all — fetched only once the
 * room has a game to show, so the first paint is the one wait here that is about
 * a download rather than about the room.
 */
const tableIsUp = (page: Page) => expect(page.locator('.pr-is-playing')).toBeVisible({ timeout: 30000 })

/**
 * Everything this browser is ever told, read off the wire rather than off the
 * screen. `dealt` is every real deck id that arrived in any frame; `open` is the
 * ids this browser is entitled to — the cards in its own hand and the ones face
 * up on the discard, both collected from those same frames. A redaction hole
 * shows up as an id in `dealt` that never made it into `open`.
 *
 * Reading the DOM could never have proved this: a leaked hand would arrive in
 * the snapshot whether or not the table chose to draw it.
 */
interface SocketWatch {
  dealt: Set<string>
  open: Set<string>
}
function watchSocket(page: Page): SocketWatch {
  const watch: SocketWatch = { dealt: new Set(), open: new Set() }
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString()
      for (const id of text.match(/prism-\d+/g) ?? []) watch.dealt.add(id)
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return // A heartbeat pong, not a snapshot.
      }
      const state = message?.snapshot?.gameState
      if (!state) return
      for (const card of state.discardPile ?? []) watch.open.add(card.id)
      const seat = message.snapshot.seatIds?.indexOf(message.you?.seat) ?? -1
      if (seat >= 0) for (const card of state.players?.[seat]?.hand ?? []) watch.open.add(card.id)
    })
  })
  return watch
}

/** Nothing this browser was not entitled to ever reached it. */
function sawOnlyItsOwn(watch: SocketWatch, atLeast: number) {
  // Without this the assertion below would pass on a socket that said nothing.
  expect(watch.dealt.size).toBeGreaterThanOrEqual(atLeast)
  expect([...watch.dealt].filter((id) => !watch.open.has(id))).toEqual([])
}

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

/** How a hand this browser is not holding is presented to it: as a count. */
async function seenAcrossTheTable(watcher: Page, held: number) {
  await expect(watcher.locator('.pr-opponent')).toContainText(held === 1 ? '1 CARD LEFT' : `${held} cards`)
}

test('two browsers deal, play and keep their cards to themselves', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)
  const hostWire = watchSocket(host)
  const guestWire = watchSocket(guest)

  await host.goto('/#/prism')
  await host.getByRole('button', { name: 'Play online', exact: true }).click()
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

  await tableIsUp(host)
  await tableIsUp(guest)
  // Seven cards each, dealt on the server, and each browser lays out only the
  // seven it was dealt.
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
  // And whatever has been played since, Ann is still a number to Ben.
  await seenAcrossTheTable(guest, await cards(host).count())

  await handOver(guest)
  await expect(myTurn(guest)).toHaveCount(0)
  await expect(myTurn(host)).toBeVisible()
  await seenAcrossTheTable(host, await cards(guest).count())

  // A reload reconnects with the stored guest id, reclaiming the seat mid-round
  // — and the hand comes back because the room, not the browser, was holding it.
  const held = await cards(guest).count()
  await guest.reload()
  await tableIsUp(guest)
  await expect(cards(guest)).toHaveCount(held)
  await expect(turnLine(guest)).toHaveText('Ann’s turn')
  await expect(guest.getByRole('button', { name: 'Draw card', exact: true })).toBeDisabled()
  await handOver(host)
  await expect(myTurn(guest)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Draw card', exact: true })).toBeEnabled()

  await guest.screenshot({ path: 'test-results/prism-online-guest.png', fullPage: true })

  // The whole round, read off both sockets: neither browser was ever sent a card
  // it had no business seeing — not in a hand, not in the pile, not in the log.
  sawOnlyItsOwn(hostWire, 8)
  sawOnlyItsOwn(guestWire, 8)
  // And they really were told different things: Ben's cards are not Ann's.
  expect([...guestWire.dealt].some((id) => !hostWire.dealt.has(id))).toBe(true)
  expect(errors).toEqual([])
})

test('a table made for four deals to the two who turned up', async ({ browser }) => {
  const errors: string[] = []
  const host = await newPlayer(browser, errors)
  const guest = await newPlayer(browser, errors)

  await host.goto('/#/prism')
  await host.getByRole('button', { name: 'Play online', exact: true }).click()
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
  await tableIsUp(host)
  await tableIsUp(guest)
  await expect(cards(host)).toHaveCount(7)
  await expect(host.locator('.pr-opponent')).toHaveCount(1)
  await expect(host.locator('.pr-opponent')).toContainText('Ben')
  await expect(myTurn(host)).toBeVisible()
  await expect(turnLine(guest)).toHaveText('Ann’s turn')
  expect(errors).toEqual([])
})
