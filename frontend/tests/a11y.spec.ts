import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import {
  FIXTURE_HANDLE,
  GAMES,
  firstMoveControl,
  openSetup,
  prepare,
  routeProfiles,
  startBotGame,
  startButton,
  tabTo,
  waitForOurTurn,
} from './support/tables'
import type { GameId, Theme } from './support/tables'

/**
 * Accessibility, checked by axe-core on every screen a visitor passes through:
 * the collection, a room's waiting screen, each game's setup and each game's
 * table mid-game against a bot — in both appearances, because most of what
 * axe catches on a site like this is contrast, and dark mode is a second
 * palette. A test fails on a serious or critical violation; moderate and minor
 * ones are attached to the report but do not fail.
 *
 * Screens with known violations are `fixme` with the reason recorded in
 * docs/a11y-findings-2026-10.md, so the suite stays green while the owners
 * fix them. `A11Y_ALL=1` runs those too; `A11Y_REPORT=<dir>` also writes each
 * screen's full result there as JSON, which is how that document was made.
 *
 * Keyboard: every game can be set up, started and given its first move with
 * the keyboard alone — focus only ever moved with Tab and arrows, actions only
 * ever taken with Enter or Space.
 */

const FINDINGS = 'Known violations: see docs/a11y-findings-2026-10.md'

/**
 * Screens that currently fail, by `<screen>/<theme>`. Remove an entry when its
 * finding is fixed — a fixed screen that stays listed is simply not checked.
 */
const KNOWN = new Set<string>([])

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const FAILING = new Set(['serious', 'critical'])

/** Skip a screen recorded as failing, unless the whole list was asked for. */
function known(key: string) {
  test.fixme(!process.env.A11Y_ALL && KNOWN.has(key), FINDINGS)
}

async function audit(page: Page, testInfo: TestInfo, key: string) {
  // Entrances and view transitions fade text in; contrast is measured on the
  // settled page, not on a frame halfway through a fade.
  await page.waitForTimeout(600)
  // The cast: @axe-core/playwright is typed against the hoisted playwright-core,
  // which can be a release ahead of @playwright/test's own. Same object at runtime.
  const results = await new AxeBuilder({ page: page as never }).withTags(TAGS).analyze()
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      target: n.target.join(' '),
      html: n.html.slice(0, 200),
      summary: n.failureSummary,
    })),
  }))
  await testInfo.attach(`axe-${key.replace(/\//g, '-')}.json`, {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  })
  if (process.env.A11Y_REPORT) {
    mkdirSync(process.env.A11Y_REPORT, { recursive: true })
    writeFileSync(
      join(process.env.A11Y_REPORT, `${key.replace(/\//g, '--')}.json`),
      JSON.stringify({ key, url: page.url(), violations: summary }, null, 2),
    )
  }
  const failing = summary.filter((v) => FAILING.has(v.impact ?? ''))
  expect(
    failing.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target).join(', ')}`),
  ).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

for (const theme of ['light', 'dark'] as Theme[]) {
  test.describe(`${theme} appearance`, () => {
    test(`home page`, async ({ page }, testInfo) => {
      known(`home/${theme}`)
      await prepare(page, theme)
      // A player with tables still open, so "Your tables" is on the page too.
      await routeProfiles(page, Date.now())
      await page.goto('/')
      await expect(page.getByRole('link', { name: 'Play Gambit', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your tables' })).toBeVisible()
      await audit(page, testInfo, `home/${theme}`)
    })

    test(`your profile`, async ({ page }, testInfo) => {
      known(`me/${theme}`)
      await prepare(page, theme)
      await routeProfiles(page, Date.now())
      await page.goto('/#/me')
      await expect(page.getByRole('heading', { name: 'Robin', level: 1 })).toBeVisible()
      await audit(page, testInfo, `me/${theme}`)
    })

    test(`a player's public profile`, async ({ page }, testInfo) => {
      known(`player/${theme}`)
      await prepare(page, theme)
      await routeProfiles(page, Date.now())
      await page.goto(`/#/player/${FIXTURE_HANDLE}`)
      await expect(page.getByRole('heading', { name: 'Robin', level: 1 })).toBeVisible()
      await audit(page, testInfo, `player/${theme}`)
    })

    test(`room waiting screen`, async ({ page }, testInfo) => {
      known(`room/${theme}`)
      await prepare(page, theme)
      await page.goto('/#/wildrise')
      await page.getByRole('button', { name: 'Play online', exact: true }).click()
      await page.getByRole('button', { name: 'Create room', exact: true }).click()
      await expect(page).toHaveURL(/\/wildrise\/room\/[A-Z2-9]{6}$/)
      await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible()
      // Seated, so the notification toggle shows; one reaction sent, so its float does.
      await page.getByRole('button', { name: /Take seat 1/ }).click()
      await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
      const reactions = page.getByRole('group', { name: 'Send a reaction' })
      await reactions.getByRole('button', { name: 'Wow' }).click()
      await expect(page.locator('.reaction-float')).toHaveCount(1)
      await audit(page, testInfo, `room/${theme}`)
    })

    for (const game of GAMES) {
      test(`${game.id} setup`, async ({ page }, testInfo) => {
        known(`${game.id}-setup/${theme}`)
        await prepare(page, theme)
        await openSetup(page, game.id)
        await audit(page, testInfo, `${game.id}-setup/${theme}`)
      })

      test(`${game.id} game against a bot`, async ({ page }, testInfo) => {
        known(`${game.id}-game/${theme}`)
        test.setTimeout(90000)
        await prepare(page, theme)
        await startBotGame(page, game.id)
        await audit(page, testInfo, `${game.id}-game/${theme}`)
      })
    }
  })
}

/**
 * Set up, start and make the first move with the keyboard alone. Chess's
 * table is its room, so its start is a room: sit, seat a bot, start.
 */
async function keyboardStart(page: Page, game: GameId) {
  await openSetup(page, game)
  const press = async (name: string | RegExp) => {
    const control = page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name })
    await tabTo(page, control.first())
    await page.keyboard.press('Enter')
  }
  if (game === 'chess') {
    await tabTo(page, page.getByLabel('Your name', { exact: true }))
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Robin')
    await tabTo(page, startButton(page, game))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible({ timeout: 30000 })
    await press(/Play as White/)
    await expect(page.getByRole('button', { name: /Leave seat/ })).toBeVisible()
    await press('Add bot')
    await expect(page.getByRole('button', { name: /^Remove / })).toBeVisible()
    await press(/^Start/)
  } else {
    if (game === 'estate') {
      await press('Remove player')
      await press('Remove player')
    } else {
      await press('2 players')
    }
    await tabTo(page, page.getByLabel('Your name', { exact: true }))
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('Robin')
    await tabTo(page, startButton(page, game))
    await page.keyboard.press('Enter')
  }
  await waitForOurTurn(page, game)
}

/**
 * What says the first move reached the server. A roll can come straight back
 * round to us within the wait (no six, the bot cannot move either), so the
 * table's own record of it is the evidence, not the button's state.
 */
function moved(page: Page, game: GameId) {
  switch (game) {
    case 'hearth':
      return page.getByText(/Robin rolled/).first()
    case 'estate':
      return page.locator('.activity-event').filter({ hasText: 'Robin' }).first()
    default:
      return firstMoveControl(page, game).and(page.locator(':disabled'))
  }
}

for (const game of GAMES) {
  test(`${game.id} can be started and played by keyboard alone`, async ({ page }) => {
    test.setTimeout(90000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await prepare(page, 'light')
    await keyboardStart(page, game.id)
    const control = firstMoveControl(page, game.id)
    await tabTo(page, control)
    if (game.id === 'chess') {
      // The cursor starts on e2: pick the pawn up, walk it two squares, put it down.
      await page.keyboard.press('Enter')
      await expect(page.locator('.ch-session .ch-panel-copy')).toContainText('on e2')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('Move history')).toContainText('e4', { timeout: 30000 })
    } else {
      await page.keyboard.press('Enter')
      await expect(moved(page, game.id)).toBeVisible({ timeout: 30000 })
    }
    expect(errors).toEqual([])
  })
}
