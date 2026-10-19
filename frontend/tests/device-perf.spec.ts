import { mkdirSync, writeFileSync } from 'node:fs'
import { devices, expect, test } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'
import { GAMES, firstMoveControl, prepare, startBotGame } from './support/tables'
import type { GameId } from './support/tables'

/**
 * A mid-range phone, approximated: Pixel 7 emulation, the CPU slowed six times
 * and DevTools' "Fast 4G" network, against the built site and a real server.
 * Per game it records how the page loads (FCP, LCP, the board's first
 * canvas), how frames come during one turn against a bot (main-thread frame
 * intervals while the table animates), which quality tier the stage settled
 * on, and the JS heap. Not a pass/fail test — the numbers go to
 * test-results/device-perf.json and docs/device-performance.md. It only runs
 * when asked: `DEVICE_PERF=1 npx playwright test tests/device-perf.spec.ts`.
 *
 * What it cannot tell you: the phone's GPU. Headless Chrome on a desktop draws
 * WebGL on the desktop's GPU (or SwiftShader), so the frame numbers are a CPU
 * story first. The real-device checklist in that document covers the rest.
 */

test.skip(!process.env.DEVICE_PERF, 'Measurement, not a test: set DEVICE_PERF=1 to run it.')

// Everything but `defaultBrowserType`, which a file may not change.
const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7']
test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

/** Chrome DevTools' "Fast 4G" preset (SDK.NetworkManager): 9 Mbps down, 1.5 up, 60 ms × 2.75. */
const FAST_4G = {
  offline: false,
  latency: 165,
  downloadThroughput: (9000 * 1000 * 0.9) / 8,
  uploadThroughput: (1500 * 1000 * 0.9) / 8,
}
const CPU_SLOWDOWN = 6
/** How long a turn is watched: our move's animation and the bot's reply. */
const TURN_MS = 8000

interface Result {
  game: GameId
  fcp: number | null
  lcp: number | null
  board: number | null
  frames: { count: number; p50: number; p95: number; p99: number; max: number; over33: number }
  quality: string | null
  heapMB: number
  renderer: string
}

const results: Result[] = []

async function throttle(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', FAST_4G)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  await cdp.send('Performance.enable')
  return cdp
}

/** Paint timings and a frame recorder, installed before the page's own scripts. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __perf: { lcp: number | null; fcp: number | null; board: number | null; frames: number[] }
    }
    w.__perf = { lcp: null, fcp: null, board: null, frames: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__perf.lcp = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.name === 'first-contentful-paint') w.__perf.fcp = entry.startTime
    }).observe({ type: 'paint', buffered: true })
    let last = 0
    const tick = (now: number) => {
      if (last) w.__perf.frames.push(now - last)
      last = now
      if (w.__perf.board === null && document.querySelector('canvas')) w.__perf.board = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0

async function firstMove(page: Page, game: GameId) {
  const control = firstMoveControl(page, game)
  if (game === 'chess') {
    await control.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
  } else {
    await control.click()
  }
}

test.describe.configure({ mode: 'serial' })

for (const game of GAMES) {
  test(`${game.id} on a throttled Pixel 7`, async ({ page }) => {
    test.setTimeout(240000)
    await instrument(page)
    await prepare(page, 'light')
    const cdp = await throttle(page)

    // Load: a cold visit to the game's page.
    await page.goto(`/#${game.path}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForTimeout(4000)
    const load = await page.evaluate(() => {
      const perf = (
        window as unknown as { __perf: { lcp: number | null; fcp: number | null; board: number | null } }
      ).__perf
      return { lcp: perf.lcp, fcp: perf.fcp, board: perf.board }
    })
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no webgl'
    })

    // A turn: our first move and the bot's answer, frame by frame.
    await startBotGame(page, game.id)
    await page.evaluate(() => {
      ;(window as unknown as { __perf: { frames: number[] } }).__perf.frames = []
    })
    await firstMove(page, game.id)
    await page.waitForTimeout(TURN_MS)
    const frames = (
      await page.evaluate(() => (window as unknown as { __perf: { frames: number[] } }).__perf.frames)
    ).sort((a, b) => a - b)
    const quality = await page.evaluate(() => sessionStorage.getItem('games-quality'))
    const { metrics } = await cdp.send('Performance.getMetrics')
    const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0

    const result: Result = {
      game: game.id,
      ...load,
      frames: {
        count: frames.length,
        p50: percentile(frames, 50),
        p95: percentile(frames, 95),
        p99: percentile(frames, 99),
        max: frames.at(-1) ?? 0,
        over33: frames.filter((f) => f > 33.4).length,
      },
      quality,
      heapMB: heap / 2 ** 20,
      renderer,
    }
    results.push(result)
    expect(frames.length).toBeGreaterThan(0)
  })
}

test.afterAll(() => {
  if (!results.length) return
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/device-perf.json', JSON.stringify(results, null, 2))
  const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)}`)
  console.log(
    '\n| Game | FCP ms | LCP ms | Board ms | Frames | p50 | p95 | p99 | max | >33ms | Tier | Heap MB |',
  )
  for (const r of results)
    console.log(
      `| ${r.game} | ${ms(r.fcp)} | ${ms(r.lcp)} | ${ms(r.board)} | ${r.frames.count} | ${r.frames.p50.toFixed(1)} | ${r.frames.p95.toFixed(1)} | ${r.frames.p99.toFixed(1)} | ${r.frames.max.toFixed(0)} | ${r.frames.over33} | ${r.quality ?? '2 (unset)'} | ${r.heapMB.toFixed(1)} |`,
    )
  console.log(`\nRenderer: ${results[0].renderer}`)
})
