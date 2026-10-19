import { expect, test } from '@playwright/test'

/**
 * Installable app and turn notifications, as far as a headless browser can
 * see them: the manifest and its icons, the service worker taking control and
 * caching the shell, and the opt-in switch — which asks for permission only
 * when pressed, and on an iPhone explains the Home Screen instead.
 */

const API = process.env.VITE_API_URL || 'http://127.0.0.1:8787'
const SHOTS = 'test-results/push'

test('the manifest describes an installable app whose icons all load', async ({ page, request }) => {
  await page.goto('/#/')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifestUrl = new URL(href!, page.url()).href
  const manifest = await (await request.get(manifestUrl)).json()
  expect(manifest).toMatchObject({ short_name: 'Games', display: 'standalone', start_url: './' })
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true)
  for (const icon of manifest.icons) {
    const res = await request.get(new URL(icon.src, manifestUrl).href)
    expect(res.status(), icon.src).toBe(200)
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect((await request.get(new URL(apple!, page.url()).href)).status()).toBe(200)
})

test('the service worker takes the page and keeps a copy of the shell', async ({ page }) => {
  // Development registers it only on request; production does on load.
  await page.addInitScript(() => localStorage.setItem('games-sw', 'on'))
  await page.goto('/#/')
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(new URL('/', page.url()).href)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open('games-shell-v1')
        return (await cache.keys()).map((request) => new URL(request.url).pathname)
      }),
    )
    .toContain('/')
  // The game server is another origin: nothing of it is ever cached.
  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url)
    return urls
  })
  expect(cached.every((url) => !url.startsWith('http://127.0.0.1:8787'))).toBe(true)
})

test('the notification switch asks only when pressed, and says what happened', async ({ browser }) => {
  const guestId = crypto.randomUUID()
  const context = await browser.newContext()
  await context.addInitScript((id) => {
    localStorage.setItem('games-guest-id', id)
    localStorage.setItem('games-guest-name', 'Ann')
  }, guestId)
  const page = await context.newPage()
  let asked = 0
  await page.exposeFunction('__asked', () => asked++)
  await page.addInitScript(() => {
    const original = Notification.requestPermission.bind(Notification)
    Notification.requestPermission = (...args: Parameters<typeof original>) => {
      ;(window as unknown as { __asked(): void }).__asked()
      return original(...args)
    }
  })
  await context.grantPermissions(['notifications'])
  await page.goto('/#/me')
  const toggle = page.getByRole('switch', { name: /Notify me when it’s my turn/ })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(asked).toBe(0)
  await page.screenshot({ path: `${SHOTS}/switch-off.png` })
  await toggle.click()
  // Subscribing reaches the browser's real push service, which a sandboxed
  // run may not: either it is on, or the switch says it could not be.
  await expect
    .poll(
      async () =>
        (await toggle.getAttribute('aria-checked')) === 'true' ||
        (await page.locator('.notify-toggle-note').count()) > 0,
      {
        timeout: 20000,
      },
    )
    .toBe(true)
  expect(asked).toBe(1)
  if ((await toggle.getAttribute('aria-checked')) === 'true') {
    const me = await (await fetch(`${API}/api/me`, { headers: { 'X-Guest-Id': guestId } })).json()
    expect(me.pushSubscriptions).toBe(1)
    await page.screenshot({ path: `${SHOTS}/switch-on.png` })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(
        async () =>
          (await (await fetch(`${API}/api/me`, { headers: { 'X-Guest-Id': guestId } })).json())
            .pushSubscriptions,
      )
      .toBe(0)
  }
  await context.close()
})

test('a seated player is offered the switch in the room; an iPhone is told how to install', async ({
  browser,
}) => {
  const guestId = crypto.randomUUID()
  const res = await fetch(`${API}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'prism', visibility: 'private', name: 'Ann', guestId, seats: 2 }),
  })
  const { code } = (await res.json()) as { code: string }
  const iphone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  await iphone.addInitScript((id) => {
    localStorage.setItem('games-guest-id', id)
    localStorage.setItem('games-guest-name', 'Ann')
    // Safari outside the Home Screen has no Push API at all.
    delete (window as unknown as { PushManager?: unknown }).PushManager
  }, guestId)
  const page = await iphone.newPage()
  await page.goto(`/#/prism/room/${code}`)
  // Watching: no switch — there is no turn to be told about.
  await expect(page.getByRole('group', { name: 'Send a reaction' })).toBeVisible()
  await expect(page.locator('.notify-toggle')).toHaveCount(0)
  await page.getByRole('button', { name: 'Take seat 1' }).click()
  await expect(page.getByRole('note')).toContainText('Add to Home Screen')
  await page.screenshot({ path: `${SHOTS}/iphone-hint.png`, fullPage: true })
  await iphone.close()
})
