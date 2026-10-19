import { describe, expect, it } from 'vitest'
import { expiryLeft, formatClock, replayHoldMs, REPLAY_HOLD, turnMarks } from './replayTiming'
import { replayUrl } from './games'

const frames = (...at: number[]) => at.map((t, n) => ({ at: t, state: { n, turn: n < 2 ? 'a' : 'b' } }))

describe('replay timing', () => {
  it('holds each state for the gap the room left, clamped, at speed', () => {
    const states = frames(0, 1000, 1005, 60_000)
    expect(replayHoldMs(states, 0, 1)).toBe(1000)
    expect(replayHoldMs(states, 0, 2)).toBe(500)
    expect(replayHoldMs(states, 1, 1)).toBe(REPLAY_HOLD.min)
    expect(replayHoldMs(states, 2, 0.5)).toBe(REPLAY_HOLD.max * 2)
    // The last state has nothing after it to measure against.
    expect(replayHoldMs(states, 3, 1)).toBe(REPLAY_HOLD.max)
  })

  it('formats a game clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65_400)).toBe('1:05')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })

  it('marks every state, or every change of turn when the game says whose it is', () => {
    const states = frames(0, 1, 2, 3)
    expect(turnMarks(states)).toEqual([0, 1, 2, 3])
    expect(turnMarks(states, (state) => (state as { turn: string }).turn)).toEqual([0, 2])
  })

  it('says how long a replay has left', () => {
    expect(expiryLeft(10, 20)).toBeNull()
    expect(expiryLeft(5 * 3_600_000 + 1, 0)).toBe('about 5 hours')
    expect(expiryLeft(90_000, 0)).toBe('1 minute')
  })

  it('builds a replay route under the game’s own path', () => {
    expect(replayUrl('chess', 'ABC234')).toBe('/chess/replay/ABC234')
    expect(replayUrl('hearth', 'ABC234')).toBe('/hearth-and-home/replay/ABC234')
  })
})
