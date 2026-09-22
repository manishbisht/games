import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  // The smoke run plays every game a good way in and takes minutes of its own:
  // `npm run test:smoke` opts into it, the default run leaves it out.
  testIgnore: process.env.SMOKE === '1' ? [] : ['**/smoke.spec.ts'],
  timeout: 60000,
  /**
   * Vitest's five seconds is short for this suite. Every game mounts a WebGL
   * scene, and every table is dealt by a real server over a real socket — so an
   * assertion is routinely waiting on a render and a round trip rather than on
   * a state update. Fifteen seconds is still short enough to fail a genuine
   * hang quickly.
   */
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  webServer: [
    {
      command: 'npm run dev -w backend',
      cwd: '..',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      // The built bundle, not the dev server. Vite transforms modules on
      // request, and across a whole run — several of these specs pull in a 3D
      // scene — a dynamic import eventually stops arriving and the page lands
      // on the chunk-error screen. Static hashed chunks do not do that, and
      // they are also what actually ships.
      command: 'npm run build && npm run preview -- --port 5173 --host 127.0.0.1 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
})
