import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { OrthographicCamera, Vector3 } from 'three'
import { createGame } from '../../shared/src/chess/engine'

async function loadPosition(page: Page, fen: string) {
  const game = createGame({}, fen)
  await page.addInitScript((saved) => {
    localStorage.setItem('gambit-game-v1', saved)
    localStorage.setItem('gambit-preferences-v1', JSON.stringify({ sound: false, reducedMotion: true }))
  }, JSON.stringify(game))
  await page.goto('/#/chess')
}

function keyboardPlayer(page: Page) {
  let current = 'e2'
  async function go(square: string) {
    await page.getByRole('group', { name: '3D chessboard', exact: true }).focus()
    const dx = square.charCodeAt(0) - current.charCodeAt(0),
      dy = Number(square[1]) - Number(current[1])
    for (let i = 0; i < Math.abs(dx); i++) await page.keyboard.press(dx > 0 ? 'ArrowRight' : 'ArrowLeft')
    for (let i = 0; i < Math.abs(dy); i++) await page.keyboard.press(dy > 0 ? 'ArrowUp' : 'ArrowDown')
    current = square
  }
  return async (from: string, to: string) => {
    await go(from)
    await page.keyboard.press('Enter')
    await expect(page.locator('.ch-session .ch-panel-copy')).toContainText(`on ${from}`)
    await go(to)
    await page.keyboard.press('Enter')
    await expect(page.locator('.ch-session .ch-panel-copy')).not.toHaveText('Making a move…')
  }
}

test('local game reaches checkmate, supports undo and restart', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/#/chess')
  await expect(page.getByRole('heading', { name: 'Pull up a chair.' })).toBeVisible()
  await expect(page.locator('.ch-canvas canvas')).toBeVisible()
  await page.screenshot({ path: 'test-results/chess-desktop-menu.png', fullPage: true })
  await page.getByRole('button', { name: 'Let’s play' }).click()
  const move = keyboardPlayer(page)
  await move('f2', 'f3')
  await move('e7', 'e5')
  await move('g2', 'g4')
  await move('d8', 'h4')
  await expect(page.getByRole('dialog', { name: 'Game result' })).toBeVisible()
  await expect(page.getByText('Black wins.', { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel('Move history')).toContainText('Qh4#')
  await page.screenshot({ path: 'test-results/chess-checkmate.png', fullPage: true })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Black’s turn.', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restart this game' }).click()
  await page.getByRole('button', { name: 'Restart game', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible()
  await expect(page.getByLabel('Move history')).not.toContainText('Qh4#')
  expect(errors).toEqual([])
})

test('rejects illegal moves, captures, restores a saved position and undoes capture', async ({ page }) => {
  await page.goto('/#/chess')
  await page.getByRole('button', { name: 'Let’s play' }).click()
  const move = keyboardPlayer(page)
  await move('e2', 'e5')
  await expect(page.getByRole('status').filter({ hasText: 'That square' })).toBeVisible()
  await page.keyboard.press('Escape')
  await move('e2', 'e4')
  await move('d7', 'd5')
  await move('e4', 'd5')
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Move history')).toContainText('exd5')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Black’s turn.', exact: true })).toBeVisible()
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible()
})

test('AI opens as White and the human can resign as Black', async ({ page }) => {
  await page.goto('/#/chess')
  await page.getByRole('button', { name: 'Play vs AI', exact: true }).click()
  await page.getByRole('button', { name: 'Black', exact: true }).click()
  await page.getByRole('button', { name: 'Easy', exact: true }).click()
  await page.getByRole('button', { name: 'Let’s play' }).click()
  await expect(page.getByRole('heading', { name: 'Black’s turn.', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator('.ch-history-row')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Resign', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm resignation' })).toContainText(
    'Black will resign and White will win.',
  )
  await page.getByRole('button', { name: 'Resign game' }).click()
  await expect(page.getByRole('dialog', { name: 'Game result' })).toContainText('White wins.')
})

test('AI replies as Black after the human makes a move', async ({ page }) => {
  await page.goto('/#/chess')
  await page.getByRole('button', { name: 'Play vs AI', exact: true }).click()
  await page.getByRole('button', { name: 'Medium', exact: true }).click()
  await page.getByRole('button', { name: 'Let’s play' }).click()
  const move = keyboardPlayer(page)
  await move('e2', 'e4')
  await expect(page.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator('.ch-history-row').first().locator('span').last()).not.toHaveText('—')
})

test('mobile setup, settings, camera controls and agreed draw', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/chess')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('switch', { name: /Reduced motion/ }).click()
  await page.getByRole('button', { name: /Cool marble/ }).click()
  await page.getByRole('button', { name: 'All set' }).click()
  await page.getByRole('button', { name: 'Flip board' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Reset camera' }).click()
  await page.getByRole('button', { name: 'Flip board' }).click()
  await page.screenshot({ path: 'test-results/chess-mobile-menu.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('switch', { name: /Keep an eye on time/ }).click()
  await page.getByRole('button', { name: 'Let’s play' }).click()
  await expect(page.getByLabel('Black clock: 10:00')).toBeVisible()
  const move = keyboardPlayer(page)
  await move('e2', 'e4')
  await move('e7', 'e5')
  await page.getByRole('group', { name: '3D chessboard', exact: true }).blur()
  await page.screenshot({ path: 'test-results/chess-mobile-playing.png', fullPage: true })
  await page.getByRole('button', { name: 'Draw', exact: true }).click()
  await page.getByRole('button', { name: 'Accept draw' }).click()
  await expect(page.getByRole('dialog', { name: 'Game result' })).toContainText('Game drawn.')
  await page.getByRole('button', { name: 'Return to menu' }).click()
  await expect(page.getByRole('heading', { name: 'Pull up a chair.' })).toBeVisible()
})

test('collection links to Gambit and help explains special moves', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Play Gambit', exact: true }).click()
  await expect(page).toHaveURL('/#/chess')
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await page.getByText('Special moves & draws', { exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('En passant:')
  await page.getByRole('button', { name: 'Back to the board' }).click()
  await page.getByRole('link', { name: 'All games', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pick your next game.' })).toBeVisible()
})

test('promotion displays original 3D choices and commits the chosen piece', async ({ page }) => {
  await loadPosition(page, '7k/P7/8/8/8/8/8/7K w - - 0 1')
  const move = keyboardPlayer(page)
  await move('a7', 'a8')
  const dialog = page.getByRole('dialog', { name: 'Promote pawn' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('canvas')).toBeVisible()
  await page.screenshot({ path: 'test-results/chess-promotion.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog.locator('canvas')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/chess-promotion-mobile.png', fullPage: true })
  await dialog.getByRole('button', { name: 'Queen', exact: true }).click()
  await expect(page.getByLabel('Move history')).toContainText('a8=Q+')
  await expect(page.getByRole('heading', { name: 'Black is in check.', exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
})

test('both castling sides are playable from the board', async ({ page }) => {
  await loadPosition(page, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
  const move = keyboardPlayer(page)
  await move('e1', 'g1')
  await expect(page.getByLabel('Move history')).toContainText('O-O')
  await move('e8', 'c8')
  await expect(page.getByLabel('Move history')).toContainText('O-O-O')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Black’s turn.', exact: true })).toBeVisible()
})

test('en passant capture removes the adjacent pawn and can be undone', async ({ page }) => {
  await loadPosition(page, '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1')
  const move = keyboardPlayer(page)
  await move('d7', 'd5')
  await move('e5', 'd6')
  await expect(page.getByLabel('Move history')).toContainText('exd6')
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toHaveCount(0)
  await move('e5', 'd6')
  await expect(page.getByLabel('White captured: Pawn', { exact: true })).toBeVisible()
})

test.describe('direct board input', () => {
  test.use({ hasTouch: true })
  test('mouse and touch select pieces through the 3D scene', async ({ page }) => {
    await page.goto('/#/chess')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('switch', { name: /Reduced motion/ }).click()
    await page.getByRole('button', { name: 'All set' }).click()
    await page.getByRole('button', { name: 'Let’s play' }).click()
    await page.getByRole('button', { name: 'View from above' }).click()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const rect = (await page.locator('.ch-canvas canvas').boundingBox())!
    // Project known board coordinates in the fixed top view, then exercise real pointer raycasting.
    const aspect = rect.width / rect.height,
      span = Math.max(4.6, 5.95 / aspect)
    const camera = new OrthographicCamera(-span * aspect, span * aspect, span, -span, 0.1, 100)
    camera.position.set(0, Math.cos(0.04) * 22, Math.sin(0.04) * 22)
    camera.lookAt(0, 0.2, 0)
    camera.updateMatrixWorld()
    async function click(square: string, touch = false) {
      const p = new Vector3(square.charCodeAt(0) - 100.5, 0.43, 4.5 - Number(square[1])).project(camera)
      const x = rect.x + ((p.x + 1) * rect.width) / 2,
        y = rect.y + ((1 - p.y) * rect.height) / 2
      if (touch) await page.touchscreen.tap(x, y)
      else await page.mouse.click(x, y)
    }
    await click('e2')
    await expect(page.locator('.ch-session .ch-panel-copy')).toContainText('Pawn on e2 · 2 legal moves')
    await page.screenshot({ path: 'test-results/chess-legal-moves.png', fullPage: true })
    await click('e4')
    await expect(page.getByLabel('Move history')).toContainText('e4')
    await expect(page.locator('.ch-session .ch-panel-copy')).not.toHaveText('Making a move…')
    await click('e7', true)
    await expect(page.locator('.ch-session .ch-panel-copy')).toContainText('Pawn on e7')
    await click('e5', true)
    await expect(page.getByLabel('Move history')).toContainText('e5')
    await expect(page.getByRole('heading', { name: 'White’s turn.', exact: true })).toBeVisible()
  })
})
