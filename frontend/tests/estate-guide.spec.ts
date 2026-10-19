import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { createGame, gameReducer } from '@games/shared/estate'
import type { GameState } from '@games/shared/estate/types'
import { PROTOCOL_VERSION } from '@games/shared/protocol'

/**
 * Estate's first-game guide, and reactions drawn at the seat that sent them.
 * A scripted room stands in for the server — like estate-motion — so the turn
 * the guide walks through is the same every run: a roll of six onto a street
 * nobody owns, which Robin passes on. The guide must finish each of those
 * steps on the real action, never block it, and be remembered once done.
 */

const CODE = 'ESGDE2'

function table(): GameState {
  return gameReducer(createGame(), {
    type: 'START',
    players: [
      { name: 'Robin', isBot: false },
      { name: 'Jules', isBot: false },
    ],
    mode: 'classic',
    seed: 7,
  })
}
const rolling = (state: GameState, dice: [number, number]): GameState => ({
  ...state,
  dice,
  rollId: state.rollId + 1,
  phase: 'rolling',
  extraRoll: false,
})
function resolved(state: GameState): GameState {
  let next = gameReducer(state, { type: 'DICE_SETTLED' })
  while (next.phase === 'moving' && next.stepsRemaining > 0) next = gameReducer(next, { type: 'MOVE_STEP' })
  return next.phase === 'moving' ? gameReducer(next, { type: 'RESOLVE' }) : next
}

/**
 * The room, scripted: it answers on whichever socket joined last and records
 * the page's actions and reactions. Development React opens the room's socket
 * twice, so the room counts as joined once every socket still open has.
 */
async function fakeRoom(page: Page) {
  let socket: WebSocketRoute | null = null
  const open = new Set<WebSocketRoute>(),
    joined = new Set<WebSocketRoute>()
  const sent: { type: string; action?: { type: string }; reaction?: string }[] = []
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}`), (ws) => {
    open.add(ws)
    ws.onClose(() => open.delete(ws))
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      const message = JSON.parse(String(raw))
      if (message.type === 'join') {
        joined.add(ws)
        socket = ws
      } else sent.push(message)
    })
  })
  const seat = (name: string) => ({ player: { name, isGuest: true }, connected: true, wantsRematch: false })
  return {
    sent,
    joined: () =>
      expect
        .poll(() => Boolean(socket && open.has(socket) && [...open].every((ws) => joined.has(ws))))
        .toBe(true),
    deal(state: GameState) {
      const now = Date.now()
      socket!.send(
        JSON.stringify({
          type: 'room',
          you: { id: 'robin', seat: 'p0', isHost: true },
          snapshot: {
            protocol: PROTOCOL_VERSION,
            code: CODE,
            game: 'estate',
            visibility: 'private',
            status: 'playing',
            seatIds: ['p0', 'p1'],
            seats: { p0: seat('Robin'), p1: seat('Jules') },
            gameState: state,
            timing: { now, since: now },
          },
        }),
      )
    },
    react(seat: string | null, reaction: string, id: string) {
      socket!.send(JSON.stringify({ type: 'reaction', seat, reaction, id, at: Date.now() }))
    },
  }
}

async function open(page: Page, guide?: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript((guide) => {
    localStorage.setItem('games-guest-name', 'Robin')
    localStorage.setItem('games-motion', 'full')
    if (guide) localStorage.setItem('games-guide-estate', guide)
  }, guide)
  const room = await fakeRoom(page)
  await page.goto(`/#/estate/room/${CODE}`)
  await room.joined()
  return { room, errors }
}

const card = (page: Page) => page.getByRole('dialog', { name: /./ }).and(page.locator('.guide-card'))
const stepIs = async (page: Page, n: number, title: string) => {
  await expect(card(page).getByRole('heading', { name: title })).toBeVisible()
  await expect(card(page)).toContainText(`${n} of 6`)
}

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 960 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`the first-game guide walks a real turn, then stays away (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const { room, errors } = await open(page)
    const shot = (name: string) => page.screenshot({ path: `test-results/estate-guide-${label}-${name}.png` })
    let state = table()
    room.deal(state)

    // 1. Roll: the ring is on the real button, focus is on the guide, and the
    // step finishes when the dice are rolled — not when Next is pressed.
    await stepIs(page, 1, 'Roll the dice')
    await expect(card(page)).toBeFocused()
    await expect(page.locator('.guide-ring')).toBeVisible()
    await page.waitForTimeout(500)
    await shot('1-roll')
    await page.getByRole('button', { name: /^Roll dice/ }).click()
    await expect.poll(() => room.sent.some((m) => m.action?.type === 'ROLL')).toBe(true)
    state = rolling(state, [2, 4])
    room.deal(state)

    // 2. The walk: it points at Robin's token, and finishes when the token lands.
    await stepIs(page, 2, 'Your token walks')
    await page.waitForTimeout(700)
    await shot('2-walk')
    state = resolved(state)
    expect(state.phase).toBe('purchase')
    room.deal(state)

    // 3. Buy or pass — the guide never stood in the way of either button.
    await stepIs(page, 3, 'Buy it, or pass')
    await page.waitForTimeout(500)
    await shot('3-buy')
    await page.getByRole('button', { name: 'Pass', exact: true }).click()
    await expect.poll(() => room.sent.some((m) => m.action?.type === 'PASS')).toBe(true)
    state = gameReducer(state, { type: 'PASS' })
    room.deal(state)

    // 4–6: rent, building and trading, each pointing at its own corner of the table.
    await stepIs(page, 4, 'Rent pays itself')
    await page.waitForTimeout(500)
    await shot('4-rent')
    await card(page).getByRole('button', { name: 'Next' }).click()
    await stepIs(page, 5, 'Build on a full set')
    await page.waitForTimeout(500)
    await shot('5-build')
    await card(page).getByRole('button', { name: 'Next' }).click()
    await stepIs(page, 6, 'Make a deal')
    await page.waitForTimeout(500)
    await shot('6-trade')
    await card(page).getByRole('button', { name: 'Done' }).click()
    await expect(page.locator('.guide-card')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('games-guide-estate'))).toBe('done')

    // Done is remembered: the next visit goes straight to the table.
    await page.reload()
    await room.joined()
    room.deal(state)
    await expect(page.getByRole('button', { name: /^(End turn|Roll again)$/ })).toBeVisible()
    await expect(page.locator('.guide-card')).toHaveCount(0)

    // …and the rules can bring it back, from the top. Escape puts it away.
    await page.getByRole('button', { name: 'How to play' }).click()
    await page.getByRole('button', { name: 'Show the guide again' }).click()
    await stepIs(page, 1, 'Roll the dice')
    await page.keyboard.press('Escape')
    await expect(page.locator('.guide-card')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('a reaction rises from the seat that sent it, and the bar sends one', async ({ page }) => {
  const { room, errors } = await open(page, 'done')
  room.deal(table())
  const bar = page.getByRole('group', { name: 'Send a reaction' })
  await expect(bar.getByRole('button')).toHaveCount(6)

  // Jules's token is on the board, so that is where Jules's reaction comes from.
  room.react('p1', 'wow', 'r1')
  const jules = page.locator('.table-reaction').filter({ hasText: 'Jules' })
  await expect(jules).toBeVisible()
  await expect(jules).toContainText('😮')
  await expect(page.locator('.table-reactions')).toContainText('Jules: Wow')
  const pinned = await jules.evaluate((bubble) => {
    const view = document.querySelector('.board-viewport')!.getBoundingClientRect()
    const x = parseFloat(bubble.style.left),
      y = parseFloat(bubble.style.top)
    return x > view.left && x < view.right && y > view.top && y < view.bottom
  })
  expect(pinned).toBe(true)
  // Someone watching has no seat: theirs rises from the middle of the board.
  room.react(null, 'nice', 'r2')
  await expect(page.locator('.table-reaction.watching')).toContainText('Someone watching')
  await page.waitForTimeout(450)
  await page.screenshot({ path: 'test-results/estate-guide-reaction.png' })

  await bar.getByRole('button', { name: 'Haha' }).click()
  await expect.poll(() => room.sent.find((m) => m.type === 'react')?.reaction).toBe('haha')
  expect(errors).toEqual([])
})
