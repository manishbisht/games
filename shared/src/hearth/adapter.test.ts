import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { hearthAdapter } from './adapter'
import { HOME } from './board'
import { phasePause } from './engine'
import type { GameState } from './types'

const SEATS = ['p0', 'p1', 'p2']
const players = [
  { id: 'p0', name: 'Ann' },
  { id: 'p1', name: 'Ben' },
  { id: 'p2', name: 'Cai' },
]
/** Every die comes up six unless a test says otherwise: a six always has a move. */
const ctx = (value = 0.99, now = 1_700_000_000_000): Ctx => ({ random: () => value, now })

const start = (seats = players) => hearthAdapter.create(seats, {}, ctx()) as GameState

/** `apply` succeeds or explains itself; tests that expect a turn to advance want the state. */
function act(state: GameState, seat: string, action: unknown, seats = SEATS) {
  const parsed = hearthAdapter.validateAction(action)
  if (!parsed) throw new Error('unreadable action')
  const result = hearthAdapter.apply(state, seat, seats, parsed, ctx())
  if ('error' in result) throw new Error(`unexpected ${result.error}`)
  return result.state
}

/** Run the timed beat the state is sitting in, the way the room's alarm would. */
function settle(state: GameState, random = 0.99) {
  const pending = hearthAdapter.pending(state)
  if (!pending) throw new Error(`phase ${state.phase} is not a timed beat`)
  return { afterMs: pending.afterMs, state: pending.resolve(state, ctx(random)) as GameState }
}

describe('hearth adapter shape', () => {
  it('seats two to four, and does not insist on a full table', () => {
    expect(hearthAdapter.id).toBe('hearth')
    expect([hearthAdapter.minSeats, hearthAdapter.maxSeats]).toEqual([2, 4])
    expect(hearthAdapter.requireFull).toBe(false)
    expect(hearthAdapter.seatIds(3)).toEqual(['p0', 'p1', 'p2'])
    expect(hearthAdapter.validateOptions({ anything: true })).toEqual({})
  })

  it('creates a table of the right size, carrying the seat names in turn order', () => {
    const state = start()
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.players.map((p) => p.id)).toEqual(['red', 'blue', 'green'])
    expect(state.phase).toBe('roll')
    expect(hearthAdapter.isFinished(state)).toBe(false)
    // Perfect information: nobody's view is redacted.
    expect(hearthAdapter.view(state, 'p1')).toBe(state)
    // The first roll waits on a person, so there is no beat to time yet.
    expect(hearthAdapter.pending(state)).toBeNull()
    expect(hearthAdapter.waitingOn(state, SEATS)).toEqual(['p0'])
  })

  it('reads the two wire actions and rejects everything else', () => {
    expect(hearthAdapter.validateAction({ kind: 'roll' })).toEqual({ kind: 'roll' })
    expect(hearthAdapter.validateAction({ kind: 'move', pieceId: 'red-0' })).toEqual({
      kind: 'move',
      pieceId: 'red-0',
    })
    for (const raw of [null, 'roll', {}, { kind: 'nope' }, { kind: 'move' }, { kind: 'move', pieceId: 3 }])
      expect(hearthAdapter.validateAction(raw)).toBeNull()
  })
})

describe('hearth adapter authorization', () => {
  it('refuses a roll from a seat that is not on turn', () => {
    expect(hearthAdapter.apply(start(), 'p1', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_YOUR_TURN',
      message: 'It is not your turn.',
    })
  })

  it('refuses a move while the dice are still in the air', () => {
    const rolling = act(start(), 'p0', { kind: 'roll' })
    expect(rolling.phase).toBe('rolling')
    expect(hearthAdapter.apply(rolling, 'p0', SEATS, { kind: 'move', pieceId: 'red-0' }, ctx())).toMatchObject(
      { error: 'NOT_ALLOWED' },
    )
    // And a second roll cannot be squeezed in either.
    expect(hearthAdapter.apply(rolling, 'p0', SEATS, { kind: 'roll' }, ctx())).toMatchObject({
      error: 'NOT_ALLOWED',
    })
  })

  it('refuses a piece the roll does not let the player move', () => {
    const { state: rolled } = settle(act(start(), 'p0', { kind: 'roll' }), 0.1) // a one
    expect(rolled.dice).toBe(1)
    expect(rolled.phase).toBe('pass')
    const six = settle(act(start(), 'p0', { kind: 'roll' })).state
    expect(six.phase).toBe('choose')
    expect(
      hearthAdapter.apply(six, 'p0', SEATS, { kind: 'move', pieceId: 'blue-0' }, ctx()),
    ).toMatchObject({ error: 'ILLEGAL_MOVE' })
  })

  it('refuses everything once the game is won', () => {
    const won = { ...start(), phase: 'won' as const, winner: 'red' as const }
    expect(hearthAdapter.apply(won, 'p0', SEATS, { kind: 'roll' }, ctx())).toMatchObject({
      error: 'NOT_PLAYING',
    })
    expect(hearthAdapter.isFinished(won)).toBe(true)
    expect(hearthAdapter.waitingOn(won, SEATS)).toEqual([])
    expect(hearthAdapter.pending(won)).toBeNull()
  })
})

describe('hearth adapter pacing', () => {
  it('walks one whole turn: roll, timed die, choice, timed move, next player', () => {
    const state = start()
    const rolling = act(state, 'p0', { kind: 'roll' })
    expect(hearthAdapter.waitingOn(rolling, SEATS)).toEqual(['p0'])

    const die = settle(rolling)
    expect(die.afterMs).toBe(phasePause('rolling', false))
    // Injected randomness, so the six (and the choice it unlocks) is deterministic.
    expect(die.state.dice).toBe(6)
    expect(die.state.phase).toBe('choose')
    expect(hearthAdapter.pending(die.state)).toBeNull()

    const moving = act(die.state, 'p0', { kind: 'move', pieceId: 'red-0' })
    expect(moving.phase).toBe('moving')
    const landed = settle(moving)
    expect(landed.afterMs).toBeGreaterThan(0)
    expect(landed.state.pieces.find((p) => p.id === 'red-0')?.progress).toBe(0)
    // A six earns another roll, so the turn stays with the seat that threw it.
    expect(landed.state.phase).toBe('roll')
    expect(hearthAdapter.waitingOn(landed.state, SEATS)).toEqual(['p0'])
  })

  it('holds a rolled-but-unplayable turn, then passes it on by itself', () => {
    const rolled = settle(act(start(), 'p0', { kind: 'roll' }), 0.1).state
    expect(rolled.phase).toBe('pass')
    const passed = settle(rolled)
    expect(passed.afterMs).toBe(phasePause('pass', false))
    expect(passed.state.phase).toBe('roll')
    expect(passed.state.currentPlayer).toBe(1)
    expect(hearthAdapter.waitingOn(passed.state, SEATS)).toEqual(['p1'])
  })

  it('times a move by how far the piece actually travels', () => {
    const six = settle(act(start(), 'p0', { kind: 'roll' })).state
    const short = hearthAdapter.pending(act(six, 'p0', { kind: 'move', pieceId: 'red-0' }))!
    // A piece entering the track takes a single step; a long walk must take longer.
    const walking: GameState = {
      ...six,
      pieces: six.pieces.map((p) => (p.id === 'red-0' ? { ...p, progress: 10 } : p)),
      legalMoves: [{ pieceId: 'red-0', from: 10, to: 16, captures: [] }],
    }
    const long = hearthAdapter.pending(act(walking, 'p0', { kind: 'move', pieceId: 'red-0' }))!
    expect(long.afterMs).toBeGreaterThan(short.afterMs)
  })
})

describe('hearth adapter absences and rematches', () => {
  it('rolls for an absent seat, then plays its piece', () => {
    const waiting = start()
    const rolling = hearthAdapter.resolveAbsent(waiting, 'p0', SEATS, ctx())!
    expect(rolling.phase).toBe('rolling')

    const choosing = settle(rolling).state
    expect(choosing.phase).toBe('choose')
    const moved = hearthAdapter.resolveAbsent(choosing, 'p0', SEATS, ctx())!
    expect(moved.phase).toBe('moving')
    expect(moved.motion?.pieceId).toBe('red-0')
  })

  it('leaves the table alone for a seat that is not on turn, and never forfeits it', () => {
    const state = start()
    // Ludo has no resignation: an absent seat is played for, at every table size.
    expect(hearthAdapter.resolveAbsent(state, 'p1', SEATS, ctx())).toBe(state)
    expect(hearthAdapter.resolveAbsent(start(players.slice(0, 2)), 'p1', ['p0', 'p1'], ctx())).not.toBeNull()
    // A beat the room is already timing is not the absent seat's to settle.
    const rolling = act(state, 'p0', { kind: 'roll' })
    expect(hearthAdapter.resolveAbsent(rolling, 'p0', SEATS, ctx())).toBe(rolling)
  })

  it('starts a fresh table for the same seats, in the same order', () => {
    const played = act(start(), 'p0', { kind: 'roll' })
    const { state, seatRemap } = hearthAdapter.rematch(played, players, {}, ctx())
    expect(seatRemap).toBeUndefined()
    expect(state.phase).toBe('roll')
    expect(state.turn).toBe(1)
    expect(state.currentPlayer).toBe(0)
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.pieces.every((p) => p.progress === -1)).toBe(true)
  })

  it('reports the winner as finished, waiting on nobody', () => {
    const home = { ...start(), pieces: start().pieces.map((p) => ({ ...p, progress: HOME })) }
    const moving: GameState = { ...home, phase: 'moving', motion: null }
    const won = hearthAdapter.pending(moving)!.resolve(moving, ctx()) as GameState
    expect(won.phase).toBe('won')
    expect(won.winner).toBe('red')
    expect(hearthAdapter.isFinished(won)).toBe(true)
    expect(hearthAdapter.waitingOn(won, SEATS)).toEqual([])
  })
})
