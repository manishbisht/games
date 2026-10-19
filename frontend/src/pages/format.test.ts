import { describe, expect, it } from 'vitest'
import { names, ordinal, timeAgo } from './format'

describe('profile formatting', () => {
  it('says how long ago, coarsely', () => {
    const now = Date.UTC(2026, 9, 19, 12)
    expect(timeAgo(now - 10_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min. ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 hr. ago')
    expect(timeAgo(now - 86_400_000, now)).toBe('yesterday')
    expect(timeAgo(now - 90 * 86_400_000, now)).toMatch(/2026/)
  })
  it('places and lists', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ])
    expect(names(['Ann'])).toBe('Ann')
    expect(names(['Ann', 'Ben', 'Cleo'])).toBe('Ann, Ben, and Cleo')
  })
})
