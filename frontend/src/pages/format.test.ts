import { describe, expect, it } from 'vitest'
import { dayAgo, names, ordinal, timeAgo, toTime } from './format'

describe('profile formatting', () => {
  it('says how long ago, coarsely', () => {
    const now = Date.UTC(2026, 9, 19, 12)
    expect(timeAgo(now - 10_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min. ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 hr. ago')
    expect(timeAgo(now - 86_400_000, now)).toBe('yesterday')
    expect(timeAgo(now - 90 * 86_400_000, now)).toMatch(/2026/)
  })
  it('says which day, for a time known only to the day', () => {
    const now = Date.UTC(2026, 9, 19, 12),
      day = (d: number) => Date.UTC(2026, 9, d)
    expect(dayAgo(day(19), now)).toBe('today')
    expect(dayAgo(day(18), now)).toBe('yesterday')
    expect(dayAgo(day(15), now)).toBe('4 days ago')
    expect(dayAgo(Date.UTC(2026, 6, 4), now)).toBe('Jul 4, 2026')
    expect(toTime('2026-10-18')).toBe(day(18))
    expect(toTime(day(18))).toBe(day(18))
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
