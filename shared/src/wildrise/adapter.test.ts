import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { wildriseAdapter } from './adapter'
import { phaseDuration } from './timing'
import type { GameState } from './types'

const SEATS = ['p0', 'p1', 'p2']
const players = [
  { id: 'p0', name: 'Ann' },
  { id: 'p1', name: 'Ben' },
  { id: 'p2', name: 'Cai' },
]
/** `0` draws the first seat and a one on the die; tests that want more say so. */
const ctx = (value = 0, now = 1_700_000_000_000): Ctx => ({ random: () => value, now })

const start = (seats = players, random = 0) => wildriseAdapter.create(seats, {}, ctx(random)) as GameState

/** `apply` succeeds or explains itself; tests that expect a turn to move want the state. */
function act(state: GameState, seat: string, action: unknown, random = 0) {
  const parsed = wildriseAdapter.validateAction(action)
  if (!parsed) throw new Error('unreadable action')
  const result = wildriseAdapter.apply(state, seat, SEATS, parsed, ctx(random))
  if ('error' in result) throw new Error(`unexpected ${result.error}`)
  return result.state
}

/** Run the timed beat the state is sitting in, the way the room's alarm would. */
function settle(state: GameState) {
  const pending = wildriseAdapter.pending(state)
  if (!pending) throw new Error(`phase ${state.phase} is not a timed beat`)
  return { afterMs: pending.afterMs, state: pending.resolve(state, ctx()) as GameState }
}

describe('wildrise adapter shape', () => {
  it('seats two to four, and does not insist on a full table', () => {
    expect(wildriseAdapter.id).toBe('wildrise')
    expect([wildriseAdapter.minSeats, wildriseAdapter.maxSeats]).toEqual([2, 4])
    expect(wildriseAdapter.requireFull).toBe(false)
    expect(wildriseAdapter.seatIds(3)).toEqual(['p0', 'p1', 'p2'])
    // The board is the board: an online table plays the printed rules.
    expect(wildriseAdapter.validateOptions({ snakeCount: 99 })).toEqual({})
  })

  it('creates a table of the right size, carrying the seat names in turn order', () => {
    const state = start()
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.players.map((p) => p.id)).toEqual(['red', 'blue', 'green'])
    expect(state.players.every((p) => p.control === 'human')).toBe(true)
    expect(state.players.every((p) => p.position === 0)).toBe(true)
    expect(state.phase).toBe('ready')
    expect(wildriseAdapter.isFinished(state)).toBe(false)
    // A race up a shared board has nothing to hide.
    expect(wildriseAdapter.view(state, 'p1')).toBe(state)
    // The first roll waits on a person, so there is no beat to time yet.
    expect(wildriseAdapter.pending(state)).toBeNull()
    expect(wildriseAdapter.waitingOn(state, SEATS)).toEqual(['p0'])
  })

  it('draws the first player from the room’s randomness', () => {
    expect(start(players, 0).currentPlayer).toBe(0)
    expect(start(players, 0.9).currentPlayer).toBe(2)
  })

  it('reads the one wire action and rejects everything else', () => {
    expect(wildriseAdapter.validateAction({ kind: 'roll' })).toEqual({ kind: 'roll' })
    // Anything riding along on a roll is dropped rather than carried inwards.
    expect(wildriseAdapter.validateAction({ kind: 'roll', value: 6 })).toEqual({ kind: 'roll' })
    for (const raw of [null, undefined, 'roll', 6, {}, { kind: 'move' }, { kind: 'ROLL' }])
      expect(wildriseAdapter.validateAction(raw)).toBeNull()
  })
})

describe('wildrise adapter authorization', () => {
  it('refuses a roll from a seat that is not on turn', () => {
    expect(wildriseAdapter.apply(start(), 'p1', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_YOUR_TURN',
      message: 'It is not your turn.',
    })
  })

  it('refuses a roll while a beat of the same turn is still running', () => {
    const rolling = act(start(), 'p0', { kind: 'roll' })
    expect(wildriseAdapter.apply(rolling, 'p0', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_ALLOWED',
      message: 'The die is not waiting on you right now.',
    })
  })

  it('throws the die itself rather than taking the seat’s word for it', () => {
    expect(act(start(), 'p0', { kind: 'roll' }, 0).dice).toBe(1)
    expect(act(start(), 'p0', { kind: 'roll' }, 0.99).dice).toBe(6)
    // The seat spends its turn on the roll, whatever number comes up.
    expect(act(start(), 'p0', { kind: 'roll' }).players[0].turns).toBe(1)
  })
})

describe('wildrise adapter pacing', () => {
  it('holds each presentation beat for as long as the local table does', () => {
    const rolling = act(start(), 'p0', { kind: 'roll' }, 0.5) // a four
    expect(rolling.phase).toBe('rolling')
    const settled = settle(rolling)
    expect(settled.afterMs).toBe(phaseDuration(rolling, false))
    expect(settled.state.phase).toBe('moving')
    expect(settled.state.motion).toEqual({ kind: 'walk', from: 0, to: 4, path: [1, 2, 3, 4] })

    const walked = settle(settled.state)
    // The walk carries a beat of slack so its last step lands rather than cuts.
    expect(walked.afterMs).toBe(phaseDuration(settled.state, false) + 300)
    expect(walked.state.players[0].position).toBe(4)
    // Four is a ladder foot, so the token is carried before the turn settles.
    expect(walked.state.phase).toBe('transporting')

    const climbed = settle(walked.state)
    expect(climbed.state.players[0].position).toBe(25)
    expect(climbed.state.phase).toBe('settling')

    const passed = settle(climbed.state)
    expect(passed.state.phase).toBe('ready')
    expect(passed.state.currentPlayer).toBe(1)
  })

  it('prices a walk by the squares it crosses, not by the turn', () => {
    const short = settle(act(start(), 'p0', { kind: 'roll' }, 0)).state // a one
    const long = settle(act(start(), 'p0', { kind: 'roll' }, 0.99)).state // a six
    expect(wildriseAdapter.pending(long)!.afterMs).toBeGreaterThan(
      wildriseAdapter.pending(short)!.afterMs,
    )
  })

  it('paces a turn that never leaves its square', () => {
    // Exact finish: an overshoot skips the walk entirely, going straight from the
    // die to the pass. Both of those beats still have to be held, or the room
    // would sit on a phase with no alarm to carry it.
    const state = start(players.slice(0, 2))
    state.players[0].position = 97
    const settled = settle(act(state, 'p0', { kind: 'roll' }, 0.99)) // a six
    expect(settled.state.phase).toBe('settling')
    expect(settled.state.motion).toBeNull()
    expect(settled.state.players[0].position).toBe(97)
    const passed = settle(settled.state)
    expect(passed.afterMs).toBeGreaterThan(0)
    expect(passed.state.phase).toBe('ready')
    expect(passed.state.currentPlayer).toBe(1)
  })

  it('holds a transport beat even though it has no squares to count', () => {
    // A snake or ladder carries the token along a curve rather than square by
    // square, so its motion has an empty path — which must not price the beat at
    // nothing and collapse the animation.
    const climbing = settle(settle(act(start(), 'p0', { kind: 'roll' }, 0.5)).state).state
    expect(climbing.phase).toBe('transporting')
    expect(climbing.motion?.path).toEqual([])
    expect(wildriseAdapter.pending(climbing)!.afterMs).toBeGreaterThan(0)
  })

  it('leaves the phases that wait on people alone', () => {
    const state = start()
    expect(wildriseAdapter.pending(state)).toBeNull()
    const won = { ...state, phase: 'won', winner: 'red' } as GameState
    expect(wildriseAdapter.pending(won)).toBeNull()
    expect(wildriseAdapter.waitingOn(won, SEATS)).toEqual([])
    expect(wildriseAdapter.isFinished(won)).toBe(true)
    expect(wildriseAdapter.apply(won, 'p0', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_PLAYING',
      message: 'The game is already won.',
    })
  })
})

describe('wildrise adapter absence and rematch', () => {
  it('rolls for a seat that has gone, and leaves every other seat alone', () => {
    const state = start()
    expect(wildriseAdapter.resolveAbsent(state, 'p0', SEATS, ctx(0.99))).toMatchObject({
      phase: 'rolling',
      dice: 6,
    })
    // Being away is not itself a move: a seat that is not on turn has nothing outstanding.
    expect(wildriseAdapter.resolveAbsent(state, 'p1', SEATS, ctx())).toBe(state)
    // A beat is already running; the room's alarm carries it, not the stand-in.
    const rolling = act(state, 'p0', { kind: 'roll' })
    expect(wildriseAdapter.resolveAbsent(rolling, 'p0', SEATS, ctx())).toBe(rolling)
  })

  it('deals a fresh table to the same seats', () => {
    const played = act(start(), 'p0', { kind: 'roll' })
    const { state, seatRemap } = wildriseAdapter.rematch(played, players, {}, ctx(0.5))
    const fresh = state as GameState
    expect(seatRemap).toBeUndefined()
    expect(fresh.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(fresh.players.every((p) => p.position === 0)).toBe(true)
    expect(fresh.phase).toBe('ready')
    expect(fresh.currentPlayer).toBe(1)
  })
})
