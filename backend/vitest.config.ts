import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // Room tests wait on beats the server paces in real time, and the helpers
  // allow up to 10s for one. A test that legitimately waits on two needs more
  // headroom than vitest's 5s default.
  test: { testTimeout: 30_000 },
})
