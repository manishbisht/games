import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

async function expectSurfaceTheme(surface: Locator, mode: 'light' | 'dark') {
  await expect(surface).toHaveCSS('color-scheme', mode)
  const brightness = await surface.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return (r + g + b) / (3 * 255)
  })
  if (mode === 'light') expect(brightness).toBeGreaterThan(0.8)
  else expect(brightness).toBeLessThan(0.25)
}

test('appearance follows the system by default and reacts to system changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expectSurfaceTheme(page.locator('.collection-page'), 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectSurfaceTheme(page.locator('.collection-page'), 'dark')
})

test('an explicit appearance persists across games and reloads until System is selected', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark')
  await page.getByRole('link', { name: 'Play Estate' }).click()
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('appearance changes sync between open tabs', async ({ page, context }) => {
  await page.goto('/')
  const other = await context.newPage()
  await other.goto('/#/chess')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark')
  await expect(other.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark')
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  await other.getByRole('combobox', { name: 'Appearance' }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('invalid stored appearance falls back to the system', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('games-appearance', 'invalid'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveValue('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('appearance still changes when preference storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (key === 'games-appearance') throw new DOMException('Storage blocked', 'SecurityError')
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'games-appearance') throw new DOMException('Storage blocked', 'SecurityError')
      setItem.call(this, key, value)
    }
  })
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('combobox', { name: 'Appearance' }).selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

const games = [
  ['hearth', '/hearth-and-home', '.hh-app'],
  ['estate', '/estate', '.app-shell'],
  ['chess', '/chess', '.ch-app'],
  ['prism', '/prism', '.pr-app'],
  ['wildrise', '/wildrise', '.wr-app'],
] as const

for (const mode of ['light', 'dark'] as const) {
  test(`${mode} appearance covers every game and room on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption(mode)
    for (const [id, path, shell] of games) {
      for (const room of [false, true]) {
        await page.goto(`/#${path}${room ? '/room/ABCDEF' : ''}`)
        const appearance = page.getByRole('combobox', { name: 'Appearance' })
        await expect(appearance).toHaveValue(mode)
        await expect(appearance).toBeInViewport()
        const surface = page.locator(room && id !== 'chess' ? '.room-shell' : shell)
        await expectSurfaceTheme(surface, mode)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({
          path: `test-results/theme-${id}-${room ? 'room' : 'game'}-${mode}.png`,
          fullPage: true,
        })
        if (!room) {
          await page.setViewportSize({ width: 1440, height: 960 })
          await expect(appearance).toBeInViewport()
          await page.screenshot({ path: `test-results/theme-${id}-desktop-${mode}.png`, fullPage: true })
          await page.getByRole('button', { name: 'How to play', exact: true }).click()
          await expectSurfaceTheme(page.getByRole('dialog'), mode)
          await page.screenshot({ path: `test-results/theme-${id}-dialog-${mode}.png` })
          await page.keyboard.press('Escape')
          await page.setViewportSize({ width: 390, height: 844 })
        }
      }
    }
  })
}
