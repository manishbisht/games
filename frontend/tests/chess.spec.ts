import { expect, test } from '@playwright/test'
import { createGame } from '../../shared/src/chess/engine'

// An old saved match must never bypass the online entry screen.
test('returning players see online rooms instead of resuming a local game', async ({ page }) => {
  await page.addInitScript((saved) => {
    localStorage.setItem('gambit-game-v1', saved)
  }, JSON.stringify(createGame()))
  await page.goto('/#/chess')
  await expect(page.getByRole('region', { name: 'Play online', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Play local|Play vs AI|Let’s play/ })).toHaveCount(0)
  await expect(page.getByLabel('Move history')).toHaveCount(0)
})

test('collection and Gambit alias open the online lobby', async ({ page }) => {
  await page.goto('/')
  const game = page.getByRole('link', { name: 'Play Gambit', exact: true })
  await game.click()
  await expect(page).toHaveURL('/#/chess')
  await expect(page.getByRole('region', { name: 'Play online', exact: true })).toBeVisible()
  await page.goto('/#/Gambit')
  await expect(page).toHaveURL('/#/chess')
  await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible()
})

test('room entry requires a name and validates a code submitted with Enter', async ({ page }) => {
  await page.goto('/#/chess')
  await page.getByLabel('Your name', { exact: true }).fill('')
  await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Room code', exact: true }).fill('ABC')
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
  await page.getByLabel('Your name', { exact: true }).fill('Sam')
  await page.getByRole('textbox', { name: 'Room code', exact: true }).press('Enter')
  await expect(page.getByRole('alert')).toContainText('six letters and numbers')
  await expect(page).toHaveURL('/#/chess')
  await page.getByRole('textbox', { name: 'Room code', exact: true }).fill('abc234')
  await page.getByRole('textbox', { name: 'Room code', exact: true }).press('Enter')
  await expect(page).toHaveURL('/#/chess/room/ABC234')
  await expect(page.getByRole('link', { name: 'Back to Gambit' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to Gambit' }).click()
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Sam')
})

test('lobby loading and failure are distinct and refresh recovers', async ({ page }) => {
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/lobby?game=chess', async (route) => {
    await pending
    await route.fulfill({ status: 503, body: '{}' })
  })
  await page.goto('/#/chess')
  await expect(page.getByRole('status').filter({ hasText: 'Looking for open rooms' })).toBeVisible()
  await expect(page.getByText('The game server is unreachable right now.')).toHaveCount(0)
  release()
  await expect(page.getByText('The game server is unreachable right now.')).toBeVisible()
  await page.unroute('**/api/lobby?game=chess')
  await page.getByRole('button', { name: 'Refresh rooms' }).click()
  await expect(page.getByText('The game server is unreachable right now.')).toHaveCount(0)
})

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
]) {
  test(`online lobby and waiting room fit ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    if (viewport.width === 390) {
      // Invite-first navigation loads room styles before lobby styles.
      await page.goto('/#/chess/room/invalid')
      await page.getByRole('link', { name: 'Back to Gambit' }).click()
    } else {
      await page.goto('/#/chess')
    }
    await page.getByLabel('Your name', { exact: true }).fill('Robin')
    await expect(page.locator('.ch-canvas canvas')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeEnabled()
    await page.getByLabel('Your name', { exact: true }).blur()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({
      path: `test-results/chess-lobby-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Create room', exact: true }).click()
    await expect(page.getByRole('heading', { name: /^Room / })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Waiting for players…' })).toBeDisabled()
    await expect(page.getByLabel('Invite a friend')).toHaveValue(page.url())
    await page.getByRole('button', { name: /Play as White/ }).click()
    await expect(page.getByRole('button', { name: /Leave seat/ })).toContainText('Robin')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({
      path: `test-results/chess-waiting-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByRole('link', { name: 'Leave room', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Play online', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
