import { describe, expect, it } from 'vitest'
import { createGame, gameReducer } from '@games/shared/estate'
import type { GameState } from '@games/shared/estate/types'
import type { ReplayFrame } from '@games/shared/protocol'
import { REPLAY_HOLD } from '../../../online/replayTiming'
import { CELEBRATION_MS, FIT, PRESENT_MS, replayPace, storyMs } from './replay'

const start = gameReducer(createGame(), {
  type: 'START',
  players: [
    { name: 'Robin', isBot: false },
    { name: 'Jules', isBot: false },
  ],
  mode: 'classic',
  seed: 7,
})
const rolling: GameState = { ...start, dice: [3, 4], rollId: 1, phase: 'rolling' }
const bought: GameState = { ...start, phase: 'end' }
const finished: GameState = { ...bought, status: 'finished', winner: 0 }

/** Robin's roll (held 3.4s by the room), the walk's end, a buy after a long think, the win. */
const frames: ReplayFrame<GameState>[] = [
  { at: 0, state: start },
  { at: 1000, state: rolling },
  { at: 4400, state: { ...start, phase: 'purchase' } },
  { at: 30_000, state: bought },
  { at: 30_250, state: finished },
]

describe('storyMs', () => {
  it('is the room’s own hold for a roll, which it timed to the dice and the walk', () => {
    expect(storyMs(frames, 1)).toBe(3400)
  })
  it('is a short present for anything a player moved on, however long they thought', () => {
    expect(storyMs(frames, 2)).toBe(PRESENT_MS)
    expect(storyMs(frames, 3)).toBe(PRESENT_MS)
  })
  it('gives the last state the winner’s celebration, and the first nothing', () => {
    expect(storyMs(frames, 4)).toBe(CELEBRATION_MS)
    expect(storyMs(frames, 0)).toBe(0)
  })
})

describe('replayPace', () => {
  it('keeps the bar’s speed when the story already fits', () => {
    expect(replayPace(frames, 2, 1)).toBe(1)
    expect(replayPace(frames, 2, 4)).toBe(4)
  })
  it('speeds up a roll the bar gives less time than the room did', () => {
    const pace = replayPace(frames, 1, 1)
    expect(pace).toBeGreaterThan(1)
    // The 3.4s story, at that pace, ends inside the 2.4s it stays on screen.
    expect(3400 / pace).toBeLessThanOrEqual(REPLAY_HOLD.max * FIT + 0.001)
  })
  it('fits a quick bot answer into its short hold', () => {
    const quick = replayPace([frames[0], { at: 100, state: bought }, { at: 300, state: start }], 1, 1)
    // 200ms between them: the coins land in 85% of it.
    expect(PRESENT_MS / quick).toBeCloseTo(200 * FIT)
  })
})
