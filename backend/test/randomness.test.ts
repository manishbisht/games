import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { secureRandom } from '../src/room'

describe('secureRandom', () => {
  it('draws a uniform [0, 1) value off workerd’s Web Crypto RNG', () => {
    for (let i = 0; i < 200; i++) {
      const value = secureRandom()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('varies from call to call rather than repeating a seed', () => {
    const draws = new Set(Array.from({ length: 50 }, () => secureRandom()))
    // Collisions in a continuous [0, 1) draw would mean the source is not
    // actually random — one repeat in 50 is already astronomically unlikely.
    expect(draws.size).toBe(50)
  })
})

it('mints room codes from the secure source, not Math.random', async () => {
  // The code is a private room's invite secret. Poisoning Math.random would
  // make every code identical if the router still defaulted to it.
  const original = Math.random
  Math.random = () => 0
  try {
    const codes = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch('https://api.test/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          game: 'wildrise',
          visibility: 'private',
          name: 'Ann',
          guestId: crypto.randomUUID(),
        }),
      })
      expect(res.status).toBe(201)
      codes.add((await res.json<{ code: string }>()).code)
    }
    expect(codes.size).toBe(5)
    expect(codes.has('AAAAAA')).toBe(false)
  } finally {
    Math.random = original
  }
})
