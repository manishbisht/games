import { describe, expect, it, vi } from 'vitest'
import { createGame, playMove } from '@games/shared/chess'
import { clockFace, hold, remaining } from './clock'

describe('clockFace', () => {
  it('reads minutes and seconds, rounding a running second up', () => {
    expect(clockFace(180_000)).toBe('3:00')
    expect(clockFace(179_001)).toBe('3:00')
    expect(clockFace(61_000)).toBe('1:01')
    expect(clockFace(10_000)).toBe('0:10')
  })

  it('shows tenths in the last ten seconds, and 0:00 only at the flag', () => {
    expect(clockFace(9_901)).toBe('0:10')
    expect(clockFace(9_900)).toBe('0:09.9')
    expect(clockFace(9_400)).toBe('0:09.4')
    expect(clockFace(50)).toBe('0:00.1')
    expect(clockFace(0)).toBe('0:00')
    expect(clockFace(-5)).toBe('0:00')
  })
})

describe('remaining', () => {
  const opened = () => {
    let game = createGame({ mode: 'online', clock: 3, increment: 2 }, undefined, 1_000)
    game = playMove(game, 'e2', 'e4', undefined, 2_000)
    return playMove(game, 'e7', 'e5', undefined, 3_000)
  }

  it('runs the side to move by the server clock carried forward, not the wall clock', () => {
    const game = opened()
    const timing = hold({ now: 3_000 + 4_000, since: 3_000 }, 500)
    vi.spyOn(performance, 'now').mockReturnValue(1_500)
    // Four seconds old when it arrived, held one more since it arrived: five seconds off White.
    expect(remaining(game, 'w', timing)).toBe(game.clocks.w - 5_000)
    expect(remaining(game, 'b', timing)).toBe(game.clocks.b)
    vi.restoreAllMocks()
  })

  it('holds both clocks still until both sides have moved', () => {
    const game = createGame({ mode: 'online', clock: 3 }, undefined, 1_000)
    expect(remaining(game, 'w', hold({ now: 90_000, since: 1_000 }, 0))).toBe(180_000)
  })
})
