import { describe, expect, it } from 'vitest'
import { createGame, gameReducer } from '@games/shared/wildrise'
import type { GameState } from '@games/shared/wildrise/types'
import { plan } from './story'
import type { Squares } from './story'

const at = (state: GameState, ...positions: number[]): GameState => ({
  ...state,
  players: state.players.map((p, i) => ({ ...p, position: positions[i] ?? p.position })),
})
const kinds = (state: GameState | null, squares: Squares, next: GameState) =>
  plan(state, squares, next, false).beats.map((b) => b.kind)

describe('the board’s story of a turn', () => {
  const ready = at(createGame({ playerCount: 2 }), 1, 10)
  const squares: Squares = { red: 1, blue: 10 }
  const rolling = gameReducer(ready, { type: 'ROLL', value: 3 })
  const moving = gameReducer(rolling, { type: 'DICE_SETTLED' })
  // 1 + 3 lands on the ladder at 4.
  const transporting = gameReducer(moving, { type: 'MOVE_DONE' })
  const settling = gameReducer(transporting, { type: 'TRANSPORT_DONE' })

  it('plays each beat as the next one arrives, at the table’s pace', () => {
    expect(kinds(ready, squares, rolling)).toEqual(['turn', 'roll'])
    const walk = plan(rolling, squares, moving, false)
    expect(walk.live).toBe(true)
    expect(walk.beats.map((b) => b.kind)).toEqual(['turn', 'walk'])
    expect(walk.beats[1]).toMatchObject({ path: [2, 3, 4], ms: 190 * 3 })
    expect(walk.squares.red).toBe(4)
    const ride = plan(moving, walk.squares, transporting, false)
    expect(ride.beats.map((b) => b.kind)).toEqual(['turn', 'ride'])
    expect(ride.beats[1]).toMatchObject({ type: 'ladder', from: 4, to: 25, ms: 1650 })
    expect(plan(transporting, ride.squares, settling, false).beats.map((b) => b.kind)).toEqual(['turn'])
  })

  it('does nothing for a snapshot that only says someone came or went', () => {
    expect(plan(moving, { red: 4, blue: 10 }, { ...moving }, false).beats).toEqual([])
  })

  it('catches up rather than replays when it joins in the middle of a turn', () => {
    const joined = plan(null, {}, transporting, false)
    expect(joined.live).toBe(false)
    expect(joined.beats.map((b) => b.kind)).toEqual(['turn', 'arrive', 'roll', 'ride'])
    // Tokens appear where the beat starts, so the ride carries on from the ladder's foot.
    const arrive = joined.beats[1]
    expect(arrive.kind === 'arrive' && arrive.moves.map((m) => m.to)).toEqual([4, 10])
    // The ride is the beat the room is in the middle of; the rest is history.
    expect(joined.playing).toBe(joined.beats[3])
  })

  it('names the beat each state is in, and none for a state that waits', () => {
    expect(plan(ready, squares, rolling, false).playing).toMatchObject({ kind: 'roll', value: 3 })
    expect(plan(null, {}, moving, false).playing).toMatchObject({ kind: 'walk', path: [2, 3, 4] })
    expect(plan(transporting, { red: 25, blue: 10 }, settling, false).playing).toBeNull()
    expect(plan(null, {}, ready, false).playing).toBeNull()
  })

  it('brings a token that skipped beats to its square before the next beat', () => {
    // A reconnect that missed the whole walk: the token hops to 4, then climbs.
    const story = plan(rolling, squares, transporting, false)
    expect(story.live).toBe(false)
    expect(story.beats.map((b) => b.kind)).toEqual(['turn', 'arrive', 'ride'])
  })

  it('shakes its head at an overshoot under the exact finish', () => {
    const near = at(createGame({ playerCount: 2 }), 98, 10)
    const rolled = gameReducer(near, { type: 'ROLL', value: 5 })
    const waited = gameReducer(rolled, { type: 'DICE_SETTLED' })
    expect(waited.phase).toBe('settling')
    const story = plan(rolled, { red: 98, blue: 10 }, waited, false)
    expect(story.beats.map((b) => b.kind)).toEqual(['turn', 'nope'])
    expect(story.beats[1]).toMatchObject({ needs: 2 })
  })

  it('prices a fast bot’s beats at its own pace', () => {
    const fast = {
      ...rolling,
      players: rolling.players.map((p, i) => (i === 0 ? { ...p, control: 'fast' as const } : p)),
    }
    const next = gameReducer(fast, { type: 'DICE_SETTLED' })
    expect(plan(fast, squares, next, false).beats[1].ms).toBeCloseTo(190 * 3 * 0.55)
  })
})
