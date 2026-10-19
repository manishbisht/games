import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * The five games as the shell specs (a11y, visual, keyboard, device) walk them:
 * where each one lives, how to reach the screen a visitor sets a table up on,
 * and how to get a table against the bots dealt and waiting on this page.
 * Kept here rather than in each spec so that when a game renames a button,
 * one file follows it.
 */

export type GameId = 'chess' | 'hearth' | 'estate' | 'prism' | 'wildrise'

export interface GameInfo {
  id: GameId
  name: string
  path: string
}

export const GAMES: GameInfo[] = [
  { id: 'chess', name: 'Gambit', path: '/chess' },
  { id: 'hearth', name: 'Hearth & Home', path: '/hearth-and-home' },
  { id: 'estate', name: 'Estate', path: '/estate' },
  { id: 'prism', name: 'Prism', path: '/prism' },
  { id: 'wildrise', name: 'Wildrise', path: '/wildrise' },
]

export type Theme = 'light' | 'dark'

/**
 * Before the first script runs: the appearance the page should paint in, sound
 * off where a game remembers it, and a name already given so no form is
 * waiting on one. Everything is localStorage, which is what the site reads.
 */
export async function prepare(page: Page, theme: Theme, extra: Record<string, string> = {}) {
  await page.addInitScript(
    ({ theme, extra }) => {
      localStorage.setItem('games-appearance', theme)
      localStorage.setItem('games-guest-name', 'Robin')
      localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false }))
      // Every game's first-game guide counts as seen, so no coach mark sits over the table.
      for (const game of ['hearth', 'estate', 'chess', 'prism', 'wildrise'])
        localStorage.setItem(`games-guide-${game}`, 'done')
      for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
    },
    { theme, extra },
  )
}

/** The screen a visitor sets a table up on, with its form ready to read. */
export async function openSetup(page: Page, game: GameId) {
  const info = GAMES.find((g) => g.id === game)!
  await page.goto(`/#${info.path}`)
  if (game === 'estate') {
    // Estate opens on its board; the setup is a dialog over it.
    await page
      .getByRole('button', { name: /^Start game/ })
      .first()
      .click()
    await expect(page.getByRole('button', { name: /Quick & spirited/ })).toBeVisible()
  } else if (game === 'chess') {
    await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
  } else {
    await expect(page.getByRole('button', { name: 'Play vs bot', exact: true })).toBeVisible()
  }
}

/** The control that turns a set-up table into a room. */
export function startButton(page: Page, game: GameId): Locator {
  if (game === 'prism') return page.getByRole('button', { name: 'Let’s play', exact: true })
  if (game === 'chess') return page.getByRole('button', { name: 'Create room', exact: true })
  // Estate's board has a "Start game" button of its own under the setup
  // dialog (its keyboard hint drops out of the name on a phone); the dialog's is the one.
  if (game === 'estate')
    return page.getByRole('dialog').getByRole('button', { name: 'Start game', exact: true })
  return page.getByRole('button', { name: 'Start game', exact: true })
}

/** The first thing the person at seat one does on their first turn. */
export function firstMoveControl(page: Page, game: GameId): Locator {
  switch (game) {
    case 'chess':
      return page.getByRole('group', { name: '3D chessboard', exact: true })
    case 'prism':
      return page.getByRole('button', { name: /^(Draw card|Draw \d+)$/ })
    case 'estate':
      return page.getByRole('button', { name: /^Roll dice/ })
    default:
      return page.getByRole('button', { name: 'Roll dice', exact: true })
  }
}

/** Seat one is waiting on this page: the table is dealt and it is our move. */
export async function waitForOurTurn(page: Page, game: GameId) {
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0, { timeout: 30000 })
  if (game === 'chess') {
    await expect(page.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible({
      timeout: 30000,
    })
  } else if (game === 'prism') {
    await expect(page.locator('.pr-card')).toHaveCount(7, { timeout: 30000 })
    await expect(page.locator('.pr-arena[aria-busy="true"]')).toHaveCount(0, { timeout: 30000 })
    await expect(firstMoveControl(page, game)).toBeEnabled({ timeout: 30000 })
  } else {
    await expect(firstMoveControl(page, game)).toBeEnabled({ timeout: 30000 })
  }
}

/**
 * A table of one person and one bot, dealt by the real server and waiting on
 * this page's first move. Chess has no solo button — its room is the lobby —
 * so the host sits as White and seats a bot as Black, as a person would.
 */
export async function startBotGame(page: Page, game: GameId) {
  await openSetup(page, game)
  if (game === 'chess') {
    await page.getByLabel('Your name', { exact: true }).fill('Robin')
    await startButton(page, game).click()
    await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: /Play as White/ }).click()
    await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
    await page.getByRole('button', { name: 'Add bot', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Remove / })).toBeVisible()
    await page.getByRole('button', { name: /^Start/ }).click()
  } else {
    if (game === 'estate') {
      for (let i = 4; i > 2; i--) await page.getByRole('button', { name: 'Remove player' }).click()
    } else {
      await page.getByRole('button', { name: '2 players', exact: true }).click()
    }
    await page.getByLabel('Your name', { exact: true }).fill('Robin')
    await startButton(page, game).click()
  }
  const info = GAMES.find((g) => g.id === game)!
  await expect(page).toHaveURL(new RegExp(`${info.path}/room/[A-Z2-9]{6}$`), { timeout: 30000 })
  await waitForOurTurn(page, game)
}

/**
 * Move focus forward with Tab, as a keyboard user would, until `target` has
 * it. Fails rather than loops when the control is not in the tab order.
 */
export async function tabTo(page: Page, target: Locator, max = 120) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)))
      return
    await page.keyboard.press('Tab')
  }
  throw new Error(`${target} is not reachable with Tab within ${max} presses`)
}

/** A fixed handle for the fixture player below (sixteen base32 characters, as the server mints them). */
export const FIXTURE_HANDLE = 'robinfixture2345'

/**
 * A player with a little history, as GET /api/me would describe them: stats in
 * three games, a chess rating, a few finished games and two tables still open
 * (one waiting on them). Fixed times, so a page that renders it never changes.
 */
export function profileFixture(now: number) {
  const minute = 60_000
  return {
    handle: FIXTURE_HANDLE,
    name: 'Robin',
    isGuest: true,
    since: now - 30 * 24 * 60 * minute,
    stats: {
      chess: { played: 12, wins: 7, losses: 4, draws: 1 },
      hearth: { played: 5, wins: 2, losses: 3, draws: 0 },
      prism: { played: 3, wins: 1, losses: 2, draws: 0 },
    },
    ratings: { chess: { rating: 1268, games: 12, provisional: false, peak: 1290 } },
    recent: [
      {
        code: 'ABC234',
        game: 'chess',
        result: 'win',
        seats: 2,
        opponents: [{ name: 'Sam', handle: 'samfixture234567' }],
        at: now - 2 * 60 * minute,
        rating: { before: 1252, after: 1268 },
      },
      {
        code: 'DEF567',
        game: 'hearth',
        result: 'loss',
        place: 2,
        seats: 3,
        opponents: [{ name: 'Jules', bot: true }, { name: 'Ana' }],
        at: now - 26 * 60 * minute,
      },
      {
        code: 'GHJ892',
        game: 'prism',
        result: 'win',
        place: 1,
        seats: 2,
        opponents: [{ name: 'Cleo', bot: true }],
        at: now - 3 * 24 * 60 * minute,
      },
    ],
    active: [
      {
        code: 'KMN345',
        game: 'chess',
        status: 'playing',
        seats: 2,
        opponents: ['Sam'],
        yourTurn: true,
        updatedAt: now - 5 * minute,
      },
      {
        code: 'PQR678',
        game: 'wildrise',
        status: 'open',
        seats: 4,
        opponents: ['Ana', 'Milo'],
        yourTurn: false,
        updatedAt: now - 40 * minute,
      },
    ],
    pushSubscriptions: 0,
  }
}

/** Answer the profile endpoints with the fixture: `/api/me`, and `/api/players/<handle>` without the private parts. */
export async function routeProfiles(page: Page, now: number) {
  const mine = profileFixture(now)
  const publicProfile = {
    handle: mine.handle,
    name: mine.name,
    isGuest: mine.isGuest,
    since: mine.since,
    stats: mine.stats,
    ratings: mine.ratings,
    recent: mine.recent.map((record) => ({ ...record, code: undefined })),
  }
  await page.route('**/api/me', (route) => route.fulfill({ json: mine }))
  await page.route('**/api/players/*', (route) => route.fulfill({ json: publicProfile }))
}
