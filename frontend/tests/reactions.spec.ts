import { expect, test } from '@playwright/test'
import type { Browser } from '@playwright/test'

/**
 * Reactions across a real room: a press in one browser floats up in the
 * other's, named for whoever sent it; a burst past the allowance rests the bar
 * rather than sending what the room would drop.
 */

const API = process.env.VITE_API_URL || 'http://127.0.0.1:8787'
const SHOTS = 'test-results/reactions'

async function person(browser: Browser, name: string, theme: 'light' | 'dark' = 'light') {
  const guestId = crypto.randomUUID()
  const context = await browser.newContext({ reducedMotion: 'no-preference' })
  await context.addInitScript(
    ({ guestId, name, theme }) => {
      localStorage.setItem('games-guest-id', guestId)
      localStorage.setItem('games-guest-name', name)
      localStorage.setItem('games-appearance', theme)
      localStorage.setItem('games-motion', 'full')
    },
    { guestId, name, theme },
  )
  return { guestId, context, page: await context.newPage() }
}

async function room(hostId: string, game = 'hearth') {
  const res = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game, visibility: 'private', name: 'Ann', guestId: hostId, seats: 2 }),
  })
  return ((await res.json()) as { code: string }).code
}

test('a reaction in one browser floats up in the other, named for its sender', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) {
    const ann = await person(browser, 'Ann', theme)
    const ben = await person(browser, 'Ben', theme)
    const code = await room(ann.guestId)
    await ann.page.goto(`/#/hearth-and-home/room/${code}`)
    await ben.page.goto(`/#/hearth-and-home/room/${code}`)
    await ann.page.getByRole('button', { name: 'Take seat 1' }).click()
    await ben.page.getByRole('button', { name: 'Take seat 2' }).click()
    await expect(ben.page.locator('.ch-room-seat-who').first()).toHaveText('Ann')

    const bar = ann.page.getByRole('group', { name: 'Send a reaction' })
    await expect(bar.getByRole('button')).toHaveCount(6)
    await bar.getByRole('button', { name: 'Wow' }).click()

    const float = ben.page.locator('.reaction-float').filter({ hasText: 'Ann' })
    await expect(float).toHaveCount(1)
    await expect(float).toContainText('😮')
    await expect(ben.page.locator('.reaction-overlay')).toContainText('Ann: Wow')
    // The sender sees their own, too.
    await expect(ann.page.locator('.reaction-float').filter({ hasText: 'Ann' })).toHaveCount(1)
    await ben.page.waitForTimeout(500)
    await ben.page.screenshot({ path: `${SHOTS}/lobby-float-${theme}.png` })

    // Ben, at phone width, answers.
    await ben.page.setViewportSize({ width: 390, height: 844 })
    await ben.page.getByRole('button', { name: 'Good game' }).click()
    await expect(ann.page.locator('.reaction-float').filter({ hasText: 'Ben' })).toContainText('🤝')
    await ben.page.waitForTimeout(400)
    await ben.page.screenshot({ path: `${SHOTS}/lobby-390-${theme}.png`, fullPage: true })
    const overflow = await ben.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await ann.context.close()
    await ben.context.close()
  }
})

test('a burst past the allowance rests the bar instead of sending', async ({ browser }) => {
  const ann = await person(browser, 'Ann')
  const ben = await person(browser, 'Ben')
  const code = await room(ann.guestId)
  await ann.page.goto(`/#/hearth-and-home/room/${code}`)
  await ben.page.goto(`/#/hearth-and-home/room/${code}`)
  await ann.page.getByRole('button', { name: 'Take seat 1' }).click()
  await expect(ben.page.locator('.ch-room-seat-who').first()).toHaveText('Ann')
  // Six presses inside one frame: faster than any refill, so only the allowance goes.
  await ann.page.getByRole('button', { name: 'Nice one' }).evaluate((button: HTMLButtonElement) => {
    for (let i = 0; i < 6; i++) button.click()
  })
  await expect(ann.page.locator('.reaction-bar')).toHaveClass(/reaction-bar-resting/)
  // Three arrive (the seated allowance), not six. A float stays in the overlay,
  // faded, once it has risen, so this counts every one that ever arrived.
  await expect(ben.page.locator('.reaction-float')).toHaveCount(3)
  await ben.page.waitForTimeout(600)
  await expect(ben.page.locator('.reaction-float')).toHaveCount(3)
  // Rested, it comes back.
  await expect(ann.page.locator('.reaction-bar')).not.toHaveClass(/reaction-bar-resting/, { timeout: 5000 })
  await ann.context.close()
  await ben.context.close()
})
