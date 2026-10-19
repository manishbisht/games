import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { getAdapter } from '@games/shared/online'
import { FIXTURE_HANDLE, GAMES, openSetup, prepare, routeProfiles } from './support/tables'
import type { GameId, Theme } from './support/tables'

/**
 * Pixel baselines for the screens that hold still: the collection (with "Your
 * tables"), the profile pages, a room's waiting screen, each game's setup, and
 * each game's table just dealt — frozen on the test clock.
 *
 * Linux only. WebGL output, font hinting and antialiasing differ between
 * machines, so a baseline is only meaningful in the environment that made it:
 * the official Playwright image CI runs this job in. Regenerate with
 * `npm run test:visual:update` (scripts/visual-baselines.sh), which runs the
 * same image locally; never from a Mac.
 *
 * Determinism, piece by piece: no server is involved — the room is a scripted
 * socket that deals a table built from the game's own adapter on a seeded
 * random, presence, the lobby and the profile endpoints are answered with
 * fixed bodies, `Math.random`
 * is seeded before any script runs, `Date` is pinned, and every stage is
 * frozen and stepped by exact frames.
 */

test.skip(process.platform !== 'linux', 'Baselines are made in the Playwright Linux image; see the header.')
// The service worker would only add a cache between the page and the build.
test.use({ serviceWorkers: 'block' })

const CODE = 'VSWZ34'
/** Every page sees the same wall clock, and every table is dealt at it. */
const NOW = Date.parse('2026-10-01T12:00:00Z')
/** How long a dealt table is left to settle before it is photographed. */
const SETTLE_MS = 1200

/**
 * Small but non-zero tolerances: 0.2% of pixels may differ, each by a little.
 * The timeout is generous because a WebGL screenshot under software rendering
 * (and under emulation, when the baselines are made on Apple silicon) is slow.
 */
const SHOT = { maxDiffPixelRatio: 0.002, threshold: 0.15, timeout: 60000 } as const

declare global {
  interface Window {
    __motionClock?: { freeze(): void; release(): void; step(ms: number): Promise<void> }
  }
}

/** A small, fast, seedable stand-in for `Math.random` (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Everything about the page that would otherwise differ from run to run. */
async function steady(page: Page, theme: Theme) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.setFixedTime(NOW)
  await prepare(page, theme, { 'games-test-clock': 'on' })
  await page.addInitScript(`Math.random = (${seeded.toString()})(20261001)`)
  await page.route('**/api/presence', (route) =>
    route.fulfill({ json: { total: 12, byGame: { hearth: 3, estate: 2, chess: 4, prism: 2, wildrise: 1 } } }),
  )
  await page.route('**/api/lobby**', (route) => route.fulfill({ json: { rooms: [] } }))
  // A player with history and two open tables: the home page's "Your tables" and the profile pages.
  await routeProfiles(page, NOW)
}

/** Freeze every stage on the page (if it has one) and step it on by `ms`. */
async function hold(page: Page, ms: number) {
  const staged = await page
    .waitForFunction(() => Boolean(window.__motionClock), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (!staged) return
  await page.evaluate(() => window.__motionClock!.freeze())
  await page.evaluate((ms) => window.__motionClock!.step(ms), ms)
}

/**
 * The room, scripted: it waits for the page to join (React may open the
 * socket twice in development; the last one to join is the one dealt to) and
 * then deals `game`'s opening table, built by the game's own adapter on a
 * seeded random, as seen from seat one.
 */
async function dealtTable(page: Page, game: GameId, open = false) {
  const adapter = getAdapter(game)!
  const seatIds = adapter.seatIds(2)
  const names = ['Robin', 'Jules']
  const state = adapter.create(
    seatIds.map((id, index) => ({ id, name: names[index] })),
    adapter.validateOptions(undefined),
    { random: seeded(7), now: NOW },
  )
  const seat = (index: number) => ({
    player: { name: names[index], isGuest: true },
    connected: true,
    wantsRematch: false,
    ...(index ? { bot: { skill: adapter.bots!.skills[0] } } : {}),
  })
  const snapshot = open
    ? // The waiting room: the host seated, a chair still free.
      {
        protocol: 3,
        code: CODE,
        game,
        visibility: 'private',
        status: 'open',
        seatIds,
        seats: { [seatIds[0]]: seat(0) },
        spectators: 0,
        gameState: null,
      }
    : {
        protocol: 3,
        code: CODE,
        game,
        visibility: 'private',
        status: 'playing',
        seatIds,
        seats: { [seatIds[0]]: seat(0), [seatIds[1]]: seat(1) },
        spectators: 0,
        gameState: adapter.view(state, seatIds[0]),
        // Dealt a minute ago: the page joins after the opening beat, at rest.
        timing: { now: NOW, since: NOW - 60_000 },
      }
  await page.routeWebSocket(new RegExp(`/api/rooms/${CODE}`), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong')
      const message = JSON.parse(String(raw)) as { type: string }
      if (message.type === 'join')
        ws.send(
          JSON.stringify({
            type: 'room',
            snapshot,
            you: { id: 'guest:robin', seat: seatIds[0], isHost: true },
          }),
        )
    })
  })
}

for (const theme of ['light', 'dark'] as Theme[]) {
  for (const [label, viewport] of [
    ['desktop', { width: 1440, height: 960 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    test(`home page, ${theme}, ${label}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await steady(page, theme)
      await page.goto('/')
      await expect(page.getByRole('link', { name: 'Play Gambit', exact: true })).toBeVisible()
      await expect(page.getByText(/12 (players )?online/i).first()).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your tables' })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await expect(page).toHaveScreenshot(`home-${theme}-${label}.png`, { fullPage: true, ...SHOT })
    })
  }
}

for (const theme of ['light', 'dark'] as Theme[]) {
  test(`your profile, ${theme}`, async ({ page }) => {
    await steady(page, theme)
    await page.goto('/#/me')
    await expect(page.getByRole('heading', { name: 'Robin', level: 1 })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot(`me-${theme}.png`, { fullPage: true, ...SHOT })
  })

  test(`room waiting screen, ${theme}`, async ({ page }) => {
    await steady(page, theme)
    await dealtTable(page, 'wildrise', true)
    await page.goto(`/#/wildrise/room/${CODE}`)
    await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Send a reaction' })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot(`room-waiting-${theme}.png`, { fullPage: true, ...SHOT })
  })
}

test(`a player's public profile`, async ({ page }) => {
  await steady(page, 'light')
  await page.goto(`/#/player/${FIXTURE_HANDLE}`)
  await expect(page.getByRole('heading', { name: 'Robin', level: 1 })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot('player-light.png', { fullPage: true, ...SHOT })
})

for (const game of GAMES) {
  test(`${game.id} setup`, async ({ page }) => {
    test.setTimeout(180000)
    await steady(page, 'light')
    await openSetup(page, game.id)
    await page.evaluate(() => document.fonts.ready)
    await hold(page, SETTLE_MS)
    await expect(page).toHaveScreenshot(`${game.id}-setup.png`, SHOT)
  })

  test(`${game.id} table, just dealt`, async ({ page }) => {
    test.setTimeout(180000)
    await steady(page, 'light')
    await dealtTable(page, game.id)
    await page.goto(`/#${game.path}/room/${CODE}`)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 })
    await page.evaluate(() => document.fonts.ready)
    // Prism deals the hand card by card on arrival; let the deal finish.
    await hold(page, game.id === 'prism' ? 4000 : SETTLE_MS)
    await expect(page).toHaveScreenshot(`${game.id}-table.png`, SHOT)
  })
}
