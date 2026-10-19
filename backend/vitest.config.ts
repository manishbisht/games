import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Push is configured in every test run, whatever backend/.dev.vars holds
      // (CI has none): the RFC 8291 example key pair, public test data, signs
      // pushes that a test's own fake push service receives.
      miniflare: {
        bindings: {
          VAPID_PUBLIC_KEY:
            'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
          VAPID_PRIVATE_KEY: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        },
      },
    }),
  ],
  // Room tests wait on beats the server paces in real time, and the helpers
  // allow up to 10s for one. A test that legitimately waits on two needs more
  // headroom than vitest's 5s default.
  test: { testTimeout: 30_000 },
})
