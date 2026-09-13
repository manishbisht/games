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
