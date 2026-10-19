import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

/**
 * Profiles end to end: a real game between two guests, played over the room's
 * own socket, shows up as a table on the home page while it is going and as a
 * result, a rating and a public profile once it is over.
 *
 * The moves go over a socket each page opens itself rather than through the 3D
 * board — the board has specs of its own, and this one is about what the
 * record makes of a game, not how the game is played.
 */

const API = process.env.VITE_API_URL || 'http://127.0.0.1:8787'
const SHOTS = 'test-results/profiles'

declare global {
  interface Window {
    __seat?: {
      send(message: unknown): void
      messages: { type: string; snapshot?: { status: string; gameState?: { history: unknown[] } | null } }[]
    }
  }
}

async function person(browser: Browser, name: string, theme: 'light' | 'dark' = 'light') {
  const guestId = crypto.randomUUID()
  const context = await browser.newContext()
  await context.addInitScript(
    ({ guestId, name, theme }) => {
      localStorage.setItem('games-guest-id', guestId)
      localStorage.setItem('games-guest-name', name)
      localStorage.setItem('games-appearance', theme)
    },
    { guestId, name, theme },
  )
  const page = await context.newPage()
  return { guestId, name, context, page }
}

/** Sit `page` at `code` over a socket of its own, as a browser would. */
async function seat(page: Page, code: string, name: string, guestId: string, seatId: string) {
  await page.evaluate(
    ({ api, code, name, guestId, seatId }) =>
      new Promise<void>((resolve) => {
        const ws = new WebSocket(`${api.replace(/^http/, 'ws')}/api/rooms/${code}`)
        const messages: NonNullable<Window['__seat']>['messages'] = []
        ws.onmessage = (event) => messages.push(JSON.parse(event.data))
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'join', protocol: 3, name, guestId, features: ['reactions'] }))
          ws.send(JSON.stringify({ type: 'sit', seat: seatId }))
          window.__seat = { send: (message) => ws.send(JSON.stringify(message)), messages }
          resolve()
        }
      }),
    { api: API, code, name, guestId, seatId },
  )
}

const send = (page: Page, message: unknown) => page.evaluate((m) => window.__seat!.send(m), message)
const moves = (page: Page) =>
  page.evaluate(() => {
    const rooms = window.__seat!.messages.filter((m) => m.type === 'room')
    return rooms.at(-1)?.snapshot?.gameState?.history.length ?? 0
  })
const status = (page: Page) =>
  page.evaluate(() => window.__seat!.messages.filter((m) => m.type === 'room').at(-1)?.snapshot?.status)

async function move(page: Page, watcher: Page, from: string, to: string) {
  const before = await moves(watcher)
  await send(page, { type: 'action', action: { kind: 'move', from, to } })
  await expect.poll(() => moves(watcher)).toBe(before + 1)
}

test('a game in progress waits on the home page, then lands on both profiles', async ({ browser }) => {
  const ann = await person(browser, 'Ann')
  const ben = await person(browser, 'Ben')
  const res = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'chess', visibility: 'private', name: 'Ann', guestId: ann.guestId }),
  })
  const { code } = (await res.json()) as { code: string }

  // The socket pages sit at the table; a second tab of Ann's looks at the home page.
  await ann.page.goto('/#/me')
  await ben.page.goto('/#/me')
  await seat(ann.page, code, 'Ann', ann.guestId, 'w')
  await seat(ben.page, code, 'Ben', ben.guestId, 'b')
  await expect.poll(() => status(ann.page)).toBe('open')
  await send(ann.page, { type: 'start' })
  await expect.poll(() => status(ben.page)).toBe('playing')

  const home = await ann.context.newPage()
  await home.goto('/#/')
  const card = home.locator('.tables-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Your turn')
  await expect(card).toContainText('Gambit')
  await expect(card).toContainText('with Ben')
  await expect(card.getByRole('link', { name: /Rejoin Gambit/ })).toHaveAttribute(
    'href',
    `#/chess/room/${code}`,
  )
  await home.screenshot({ path: `${SHOTS}/home-your-turn.png` })

  // After Ann moves it is Ben's turn, and the strip says so when the tab comes back.
  await move(ann.page, ben.page, 'f2', 'f3')
  await home.reload()
  await expect(home.locator('.tables-card')).toContainText('Their move')

  // Fool's mate.
  await move(ben.page, ann.page, 'e7', 'e5')
  await move(ann.page, ben.page, 'g2', 'g4')
  await move(ben.page, ann.page, 'd8', 'h4')
  await expect.poll(() => status(ann.page)).toBe('finished')

  // Over: no table to go back to, and a result on Ann's own page.
  await home.reload()
  await expect(home.locator('.collection-grid')).toBeVisible()
  await expect(home.locator('.tables-card')).toHaveCount(0)
  await home.goto('/#/me')
  await expect(home.getByRole('heading', { name: 'Ann', level: 1 })).toBeVisible()
  await expect(home.locator('.profile-rating-number')).toHaveText('1180')
  await expect(home.locator('.profile-rating')).toContainText('Provisional · 1 of 10')
  await expect(home.locator('.profile-stats')).toContainText('Gambit')
  await expect(home.locator('.profile-stats')).toContainText('1 lost')
  const row = home.locator('.profile-history li').first()
  await expect(row).toContainText('Lost')
  await expect(row).toContainText('vs Ben')
  await expect(row.locator('.profile-delta')).toHaveText('−20')
  await home.screenshot({ path: `${SHOTS}/me-light.png`, fullPage: true })

  // Ben's public page, from Ann's history: his win, his rating, no room code.
  await row.getByRole('link', { name: 'Ben' }).click()
  await expect(home).toHaveURL(/#\/player\/[a-z2-7]{16}$/)
  await expect(home.getByRole('heading', { name: 'Ben', level: 1 })).toBeVisible()
  await expect(home.locator('.profile-rating-number')).toHaveText('1220')
  await expect(home.locator('.profile-history li').first()).toContainText('Won')
  await expect(home.locator('body')).not.toContainText(code)
  await expect(home.locator('.tables')).toHaveCount(0)
  await expect(home.getByRole('switch')).toHaveCount(0)
  await home.screenshot({ path: `${SHOTS}/player-light.png`, fullPage: true })

  await ann.context.close()
  await ben.context.close()
})

test('a newcomer’s page explains how the record starts, in either theme and at phone width', async ({
  browser,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    const visitor = await person(browser, 'Robin', theme)
    await visitor.page.setViewportSize({ width: 390, height: 844 })
    await visitor.page.goto('/#/me')
    await expect(visitor.page.getByRole('heading', { name: /first online game/ })).toBeVisible()
    await expect(visitor.page.getByRole('link', { name: 'Find a game' })).toBeVisible()
    const overflow = await visitor.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await visitor.page.screenshot({ path: `${SHOTS}/me-empty-390-${theme}.png`, fullPage: true })
    await visitor.context.close()
  }
})

test('an unknown player is a friendly not-found, not an error', async ({ page }) => {
  await page.goto('/#/player/aaaaaaaaaaaaaaaa')
  await expect(page.getByRole('heading', { name: 'We couldn’t find that player.' })).toBeVisible()
})
