import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PROTOCOL_VERSION } from '@games/shared/protocol'

/**
 * A room's finished game, played back. The fastest game to finish is chess
 * against a bot: two moves each, then a resignation — made from a second
 * socket of the same player, so nothing here leans on the board's own buttons.
 */

const API = process.env.VITE_API_URL || 'http://127.0.0.1:8787'

type Theme = 'light' | 'dark'

/** A chess room against the easy bot, played two moves deep and resigned, open on `page`. */
async function finishedGame(page: Page, theme: Theme = 'light') {
  const guestId = crypto.randomUUID()
  await page.addInitScript(
    ({ guestId, theme }) => {
      localStorage.setItem('games-guest-id', guestId)
      localStorage.setItem('games-guest-name', 'Robin')
      localStorage.setItem('games-appearance', theme)
      localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false }))
    },
    { guestId, theme },
  )
  const created = await page.request.post(`${API}/api/rooms`, {
    data: {
      game: 'chess',
      visibility: 'private',
      name: 'Robin',
      guestId,
      seats: 2,
      bots: ['easy'],
      autoStart: true,
    },
  })
  expect(created.status()).toBe(201)
  const { code } = (await created.json()) as { code: string }
  await page.goto(`/#/chess/room/${code}`)
  await expect(page.getByRole('heading', { name: /^Room / })).toHaveCount(0)

  await page.evaluate(
    async ({ api, code, guestId, protocol }) => {
      type Room = {
        type: 'room'
        snapshot: { status: string; gameState: { turn: string; history: unknown[] } | null }
      }
      const ws = new WebSocket(`${api.replace(/^http/, 'ws')}/api/rooms/${code}`)
      await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
      const waitFor = (predicate: (room: Room) => boolean) =>
        new Promise<Room>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the room never got there')), 20_000)
          const check = (event: MessageEvent) => {
            const message = JSON.parse(event.data as string)
            if (message.type !== 'room' || !predicate(message)) return
            clearTimeout(timer)
            ws.removeEventListener('message', check)
            resolve(message)
          }
          ws.addEventListener('message', check)
        })
      const joined = waitFor((room) => room.snapshot.status === 'playing')
      ws.send(JSON.stringify({ type: 'join', protocol, name: 'Robin', guestId }))
      await joined
      for (const [index, [from, to]] of [
        ['e2', 'e4'],
        ['g1', 'f3'],
      ].entries()) {
        // White moves; the bot answers.
        const answered = waitFor(
          (room) =>
            room.snapshot.gameState?.turn === 'w' &&
            room.snapshot.gameState.history.length === (index + 1) * 2,
        )
        ws.send(JSON.stringify({ type: 'action', action: { kind: 'move', from, to } }))
        await answered
      }
      const over = waitFor((room) => room.snapshot.status === 'finished')
      ws.send(JSON.stringify({ type: 'action', action: { kind: 'resign' } }))
      await over
      ws.close()
    },
    { api: API, code, guestId, protocol: PROTOCOL_VERSION },
  )
  return code
}

const position = (page: Page) =>
  page
    .getByRole('slider', { name: 'Replay position' })
    .evaluate((input) => Number((input as HTMLInputElement).value))

test('a finished game plays back, and every control drives it', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const code = await finishedGame(page)

  // The room offers the finished game back.
  const link = page.getByRole('link', { name: 'Watch the replay' })
  await expect(link).toBeVisible()
  await page.screenshot({ path: 'test-results/replay-room-link.png' })
  expect(await link.getAttribute('href')).toBe(`#/chess/replay/${code}`)
  await page.goto(`/#/chess/replay/${code}`)

  await expect(page.getByRole('heading', { level: 1, name: /^Robin vs / })).toBeVisible()
  await expect(page.getByText(`Replay · Room ${code}`)).toBeVisible()
  await expect(
    page.getByText(/gone 24 hours after its last move — this one has about 2[34] hours left/),
  ).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Replay position' })
  // Start, two moves each, the resignation: at least six states.
  const last = Number(await slider.getAttribute('max'))
  expect(last).toBeGreaterThanOrEqual(5)

  // It plays on its own, to the end, and then offers to go again.
  await expect.poll(() => position(page), { timeout: 20_000 }).toBe(last)
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible()
  await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`^Moment ${last + 1} of ${last + 1}`))

  // Home, End and the arrows, from anywhere on the page.
  await page.keyboard.press('Home')
  expect(await position(page)).toBe(0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  expect(await position(page)).toBe(2)
  await page.keyboard.press('ArrowLeft')
  expect(await position(page)).toBe(1)
  await page.keyboard.press('End')
  expect(await position(page)).toBe(last)

  // The step buttons, and their limits.
  await expect(page.getByRole('button', { name: 'Step forward' })).toBeDisabled()
  await page.getByRole('button', { name: 'Step back' }).click()
  expect(await position(page)).toBe(last - 1)

  // Space plays and pauses; faster is faster.
  await page.getByRole('button', { name: '4×' }).click()
  await expect(page.getByRole('button', { name: '4×' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Home')
  // A focused button keeps Space for itself, as buttons do; the page has it otherwise.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(' ')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(() => position(page), { timeout: 10_000 }).toBeGreaterThan(0)
  await page.keyboard.press(' ')
  await expect(page.getByRole('button', { name: /^Play/ })).toBeVisible()
  const paused = await position(page)
  await page.waitForTimeout(800)
  expect(await position(page)).toBe(paused)

  // The scrubber goes straight to a moment.
  await slider.fill('3')
  expect(await position(page)).toBe(3)
  await expect(slider).toHaveAttribute('aria-valuetext', /^Moment 4 of/)

  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/chess/replay/${code}`)

  expect(errors).toEqual([])
})

test('under reduced motion nothing plays until asked', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const code = await finishedGame(page)
  await page.goto(`/#/chess/replay/${code}`)
  await expect(page.getByRole('slider', { name: 'Replay position' })).toBeVisible()
  await page.waitForTimeout(3000)
  expect(await position(page)).toBe(0)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => position(page), { timeout: 10_000 }).toBeGreaterThan(0)
})

test('a replay that is not there says why', async ({ page }) => {
  await page.goto('/#/chess/replay/ZZZZZZ')
  await expect(page.getByRole('heading', { name: 'This replay isn’t here.' })).toBeVisible()
  await expect(page.getByText(/24 hours after the last move/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Gambit' })).toBeVisible()
})

for (const theme of ['light', 'dark'] as const)
  test(`replay page screenshots, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const code = await finishedGame(page, theme)
    await page.goto(`/#/chess/replay/${code}`)
    const slider = page.getByRole('slider', { name: 'Replay position' })
    await expect(slider).toBeVisible()
    await slider.fill('3')
    await page.screenshot({ path: `test-results/replay-desktop-${theme}.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(slider).toBeVisible()
    // No sideways scroll at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `test-results/replay-phone-${theme}.png`, fullPage: true })
  })
